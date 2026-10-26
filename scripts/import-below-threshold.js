// Sends the AI rows' hidden entries that the confidence thresholds keep from viewers (sponsor below medium,
// self_promotion below high; with --min-seconds below AI_MIN_SEGMENT_SECONDS also the ones hidden as too
// short) to the assessors as ai items on their AI row: a keep verdict serves the entry (unless it is short),
// not_ad / unclear hide it for good (prv/repository/ai.js applyVerdict). Entries hidden on review are never sent.
// A segment already in prv_review_items (same native_id, bounds and category, any sheet) is skipped, so a later
// run imports only the segments of new detections.
//
// Usage: DB_NAME=… DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… \
//        node scripts/import-below-threshold.js [--sheet NAME] [--priority urgent|important|optional]
//        [--max-items N] [--min-seconds S] [--empty-only] [--dry-run]
// --min-seconds: skip segments shorter than S s (default AI_MIN_SEGMENT_SECONDS, lib/ai-rules.js: a short
//   mention cannot be served whatever its confidence, and streams produce dozens of 1–5 s sponsor mentions);
//   below the threshold the entries hidden as short come too, 0 = all of them.
// --sheet: default ai-below-threshold-<YYYY-MM-DD> (UTC); a sheet that already has items is refused.
// --priority: default optional (a pass for when there is time). --max-items: part size (default 30).
// --empty-only: only videos whose AI row serves nothing and is not withdrawn (the funnel's stage 9).
// --dry-run: print the items, write nothing.

const { splitSheet } = require('../lib/review-sheet');
const { scriptSequelize } = require('../lib/script-db');
const { MIN_SEGMENT_SECONDS, HIDDEN_REASONS } = require('../lib/ai-rules');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');
const { PRIORITIES } = createReviewRepository;

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
        + ' [--max-items N] [--min-seconds S] [--empty-only] [--dry-run]');
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { sheet: `ai-below-threshold-${new Date().toISOString().slice(0, 10)}`, priority: 'optional', maxItems: 30, minSeconds: MIN_SEGMENT_SECONDS, emptyOnly: false, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const m = /^--(sheet|priority|max-items|min-seconds)(?:=(.*))?$/.exec(a);
        if (a === '--empty-only') opts.emptyOnly = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (m) {
            const value = m[2] != null ? m[2] : argv[++i];
            if (!value) usage(`--${m[1]} needs a value`);
            if (m[1] === 'max-items') {
                if (!/^[1-9]\d*$/.test(value)) usage('--max-items needs a positive integer');
                opts.maxItems = Number(value);
            } else if (m[1] === 'min-seconds') {
                if (!/^\d+(\.\d+)?$/.test(value)) usage('--min-seconds needs a number');
                opts.minSeconds = Number(value);
            } else if (m[1] === 'priority') {
                if (!PRIORITIES.includes(value)) usage(`--priority must be one of ${PRIORITIES.join(', ')}`);
                opts.priority = value;
            } else opts.sheet = value;
        } else usage(`unknown option ${a}`);
    }
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const sequelize = scriptSequelize();
    const models = definePrvModels(sequelize);
    const review = createReviewRepository(models, sequelize);
    try {
        const rows = await sequelize.query(
            `SELECT c.native_id, c.video_id, c.hidden, r.id AS run_id, r.transcript -> 'cues' AS cues
               FROM prv_ai_video_calculateds c JOIN prv_ai_runs r ON r.id = c.run_id
              WHERE jsonb_array_length(c.hidden) > 0
                ${opts.emptyOnly ? "AND jsonb_array_length(c.data) = 0 AND c.withdrawn_at IS NULL" : ''}
              ORDER BY r.id`,
            { type: sequelize.QueryTypes.SELECT }
        );
        const categories = new Map((await models.MarkupCategory.findAll()).map((c) => [c.id, c.category]));
        const reasons = opts.minSeconds < MIN_SEGMENT_SECONDS ? [HIDDEN_REASONS.CONFIDENCE, HIDDEN_REASONS.SHORT] : [HIDDEN_REASONS.CONFIDENCE];
        const candidates = [];
        for (const row of rows) {
            for (const e of row.hidden) {
                if (!reasons.includes(e.reason) || e.end - e.start < opts.minSeconds) continue;
                const category = categories.get(e.category_id);
                candidates.push({
                    native_id: row.native_id, video_id: row.video_id, kind: 'ai', start: e.start, end: e.end, proposed: category,
                    cues: (row.cues || []).filter((c) => c.end > e.start && c.start < e.end).map((c) => c.text).join('\n') || null,
                    link: linkAt(row.native_id, e.start - 2),
                    flagged_by: [`detect run ${row.run_id}: ${category} ${e.confidence}, ${e.end - e.start} s, hidden: ${e.reason}`],
                });
            }
        }
        const fresh = [];
        for (const c of candidates) {
            if (!(await review.hasItemAt(c))) fresh.push(c);
        }
        const videos = new Set(fresh.map((c) => c.native_id)).size;
        console.log(`${candidates.length} segments below the threshold and at least ${opts.minSeconds} s, ${fresh.length} not yet in review (${videos} videos)`);
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
