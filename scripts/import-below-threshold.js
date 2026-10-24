// Sends the detector's segments that the publish thresholds dropped (sponsor below
// medium, self_promotion below high, or shorter than 5 s after rounding inward) to
// the assessors as ordinary sheet items: their verdicts measure whether the
// thresholds lose ads, they never touch the AI row (kind = 'sheet', no video_id).
// A segment already in prv_review_items (same native_id, bounds and category, any
// sheet) is skipped, so a later run imports only the segments of new detections.
//
// Usage: DB_NAME=… DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… \
//        node scripts/import-below-threshold.js [--sheet NAME] [--priority urgent|important|optional]
//        [--max-items N] [--empty-only] [--dry-run]
// --sheet: default ai-below-threshold-<YYYY-MM-DD> (UTC); a sheet that already has items is refused.
// --priority: default optional (a pass for when there is time). --max-items: part size (default 30).
// --empty-only: only videos whose AI row has no entry at all (the funnel's stage 9).
// --dry-run: print the items, write nothing.

const { splitSheet } = require('../lib/review-sheet');
const { scriptSequelize } = require('../lib/script-db');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');
const { PRIORITIES } = createReviewRepository;

// ai/pipeline/publish.go: accepted() and minSegmentSeconds, with its inward rounding.
const MIN_SEGMENT_SECONDS = 5;
function published(seg, start, end) {
    const confident = seg.category === 'sponsor' ? ['high', 'medium'].includes(seg.confidence) : seg.confidence === 'high';
    return confident && Math.floor(end) - Math.ceil(start) >= MIN_SEGMENT_SECONDS;
}

// provider.LinkAt in Go: the player opens 2 s early, as every sheet link does.
function linkAt(nativeId, seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const t = h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
    return `https://example.invalid/video${nativeId}?t=${t}`;
}

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-below-threshold.js [--sheet NAME] [--priority urgent|important|optional]'
        + ' [--max-items N] [--empty-only] [--dry-run]');
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { sheet: `ai-below-threshold-${new Date().toISOString().slice(0, 10)}`, priority: 'optional', maxItems: 30, emptyOnly: false, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const m = /^--(sheet|priority|max-items)(?:=(.*))?$/.exec(a);
        if (a === '--empty-only') opts.emptyOnly = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (m) {
            const value = m[2] != null ? m[2] : argv[++i];
            if (!value) usage(`--${m[1]} needs a value`);
            if (m[1] === 'max-items') {
                if (!/^[1-9]\d*$/.test(value)) usage('--max-items needs a positive integer');
                opts.maxItems = Number(value);
            } else if (m[1] === 'priority') {
                if (!PRIORITIES.includes(value)) usage(`--priority must be one of ${PRIORITIES.join(', ')}`);
                opts.priority = value;
            } else opts.sheet = value;
        } else usage(`unknown option ${a}`);
    }
    return opts;
}

const round1 = (x) => Math.round(x * 10) / 10;

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const sequelize = scriptSequelize();
    const models = definePrvModels(sequelize);
    const review = createReviewRepository(models, sequelize);
    try {
        const rows = await sequelize.query(
            `SELECT c.native_id, r.id AS run_id, r.raw_output, r.transcript -> 'cues' AS cues
               FROM prv_ai_video_calculateds c JOIN prv_ai_runs r ON r.id = c.run_id
              WHERE jsonb_typeof(r.raw_output) = 'object'
                ${opts.emptyOnly ? "AND jsonb_array_length(c.data) = 0 AND c.withdrawn_at IS NULL" : ''}
              ORDER BY r.id`,
            { type: sequelize.QueryTypes.SELECT }
        );
        const candidates = [];
        for (const row of rows) {
            const cues = row.cues || [];
            for (const seg of (row.raw_output.segments || [])) {
                const first = cues[seg.first_cue], last = cues[seg.last_cue];
                if (!first || !last) {
                    console.error(`run ${row.run_id}: segment cues ${seg.first_cue}-${seg.last_cue} outside the transcript, skipped`);
                    continue;
                }
                const start = round1(first.start), end = round1(last.end);
                if (published(seg, first.start, last.end)) continue;
                candidates.push({
                    native_id: row.native_id, start, end, proposed: seg.category,
                    cues: cues.slice(seg.first_cue, seg.last_cue + 1).map((c) => c.text).join('\n') || null,
                    link: linkAt(row.native_id, start - 2),
                    flagged_by: [`detect run ${row.run_id}: ${seg.category} ${seg.confidence}, ${round1(end - start)} s, below the publish threshold`],
                });
            }
        }
        const fresh = [];
        for (const c of candidates) {
            const [dup] = await sequelize.query(
                `SELECT 1 FROM prv_review_items
                  WHERE native_id = :native_id AND proposed = :proposed AND ABS(start - :start) < 0.05 AND ABS("end" - :end) < 0.05 LIMIT 1`,
                { replacements: c, type: sequelize.QueryTypes.SELECT }
            );
            if (!dup) fresh.push(c);
        }
        const videos = new Set(fresh.map((c) => c.native_id)).size;
        console.log(`${candidates.length} segments below the threshold, ${fresh.length} not yet in review (${videos} videos)`);
        if (fresh.length === 0) return;
        const items = fresh.map((c, i) => ({ ...c, position: i + 1, item_code: `B${i + 1}` }));
        if (opts.dryRun) {
            for (const it of items) console.log(`${it.item_code}\t${it.native_id}\t${it.start}\t${it.end}\t${it.proposed}\t${it.flagged_by[0]}`);
            return;
        }
        if ((await review.itemsInSheet(opts.sheet)).length > 0) {
            throw new Error(`sheet ${opts.sheet} already has items: pick another --sheet`);
        }
        const parts = splitSheet(opts.sheet, items, opts.maxItems);
        await sequelize.transaction(async (transaction) => {
            for (const part of parts) {
                await review.createBatch(part.batch, { reviews_needed: 1, priority: opts.priority }, { transaction });
                await review.insertItems(opts.sheet, part.batch, part.items, { transaction });
            }
        });
        console.log(`imported ${items.length} items into ${parts.map((p) => `${p.batch} (${p.items.length})`).join(', ')}`);
    } finally {
        await sequelize.close();
    }
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
