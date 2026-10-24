// Imports segment bounds that assessors typed into verdict comments before the
// review page had bounds fields (2026-10-24). Per row, appends a verdict that
// copies the reviewer's latest verdict and comment on the item and carries the
// bounds (source 'import', bounds_source 'import'); on an ai item it moves the
// AI entry as a page verdict would. One transaction with every touched batch
// row locked; nothing is written when any row is malformed or names an unknown
// item or reviewer (exit 1). Rows that cannot be applied are skipped with the
// reason: no verdict by the reviewer, a later verdict by someone else (the copy
// would override it), the latest verdict is not a keep, invalid bounds, or the
// item already has these bounds.
//
// TSV: `sheet item_code reviewer start end`, an optional header line starting
// with `sheet`, `#` comment lines. `sheet` is a sheet or a batch name;
// `reviewer` `-` = whoever has the item's latest verdict; times as the review
// page reads them (seconds, m:ss, h:mm:ss).
//
// Usage: DB_NAME=… DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… \
//        node scripts/import-verdict-bounds.js <bounds.tsv> [--dry-run]

const fs = require('node:fs');
const { parsePlayerTime, validateVerdictBounds } = require('../lib/review-sheet');
const { scriptSequelize } = require('../lib/script-db');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');
const createAiRepository = require('../prv/repository/ai');
const { KEEP_VERDICTS } = createReviewRepository;

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-verdict-bounds.js <bounds.tsv> [--dry-run]');
    process.exit(2);
}

// Rows `{ line, sheet, item_code, reviewer, start, end }`; throws on a malformed one.
function parseTsv(text) {
    const rows = [];
    String(text).split(/\r?\n/).forEach((raw, i) => {
        const line = i + 1;
        if (raw.trim() === '' || raw.trimStart().startsWith('#') || (rows.length === 0 && /^sheet\t/.test(raw))) return;
        const f = raw.split('\t').map((c) => c.trim());
        if (f.length !== 5 || f.some((c) => c === '')) throw new Error(`line ${line}: expected 5 tab-separated fields`);
        const [sheet, item_code, reviewer, startText, endText] = f;
        const start = parsePlayerTime(startText);
        const end = parsePlayerTime(endText);
        if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(`line ${line}: cannot read the times ${startText} / ${endText}`);
        rows.push({ line, sheet, item_code, reviewer, start, end });
    });
    return rows;
}

const ROLLBACK = new Error('dry run');

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const files = args.filter((a) => a !== '--dry-run');
    if (files.length !== 1 || files[0].startsWith('-')) usage();
    const rows = parseTsv(fs.readFileSync(files[0], 'utf8'));

    const sequelize = scriptSequelize();
    try {
        const models = definePrvModels(sequelize);
        const review = createReviewRepository(models, sequelize);
        const ai = createAiRepository(models, sequelize);
        for (const row of rows) {
            const found = await review.itemsByCode(row.sheet, row.item_code);
            if (found.length !== 1) throw new Error(`line ${row.line}: ${found.length === 0 ? 'no' : 'more than one'} item ${row.sheet} ${row.item_code}`);
            row.item_id = found[0].id;
            row.batch = found[0].batch;
            if (row.reviewer !== '-' && !(await review.isReviewer(row.reviewer))) throw new Error(`line ${row.line}: unknown reviewer ${row.reviewer}`);
        }

        const results = [];
        try {
            await sequelize.transaction(async (transaction) => {
                for (const batch of [...new Set(rows.map((r) => r.batch))].sort()) {
                    await review.lockBatchRow(batch, { transaction });
                }
                for (const row of rows) {
                    const item = await review.getItemById(row.item_id, { transaction });
                    const reviewer = row.reviewer === '-' ? (item.verdict && item.verdict.reviewer) : row.reviewer;
                    const own = item.history.find((h) => h.reviewer === reviewer);
                    const bounds = { start: row.start, end: row.end, source: 'import' };
                    const why = validateVerdictBounds(bounds);
                    const eff = item.effective_bounds;
                    let skip = null;
                    if (!own) skip = `no verdict by ${reviewer || 'anyone'}`;
                    else if (item.verdict.id !== own.id) skip = `a later verdict by ${item.verdict.reviewer}`;
                    else if (!KEEP_VERDICTS.has(own.verdict)) skip = `latest verdict is ${own.verdict}, not a keep`;
                    else if (why) skip = `bounds ${row.start}-${row.end}: ${why}`;
                    else if (eff.start === row.start && eff.end === row.end) skip = 'already has these bounds';
                    if (!skip) {
                        await review.recordVerdict({
                            item_id: item.id, verdict: own.verdict, comment: own.comment, reviewer, source: 'import', bounds, transaction,
                        });
                        if (item.kind === 'ai') await ai.applyVerdict(item, own.verdict, { from: eff, to: bounds, transaction });
                    }
                    results.push({ row, reviewer, skip });
                }
                if (dryRun) throw ROLLBACK;
            });
        } catch (e) {
            if (e !== ROLLBACK) throw e;
        }
        for (const { row, reviewer, skip } of results) {
            const what = `${row.sheet} ${row.item_code} ${reviewer || '-'} ${row.start}-${row.end}`;
            console.log(skip ? `skipped ${what}: ${skip}` : `${dryRun ? 'would apply' : 'applied'} ${what}`);
        }
        const applied = results.filter((r) => !r.skip).length;
        console.log(`${dryRun ? 'dry run: ' : ''}${applied} applied, ${results.length - applied} skipped`);
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(`import failed: ${e.message}`);
    process.exit(1);
});
