// Turns the sheet items of a below-threshold sheet imported before the AI rows kept their hidden entries
// (`ai-below-threshold-2026-10-24`) into ai items on those entries, and applies each item's latest verdict to the
// AI row as a page verdict would (prv/repository/ai.js applyVerdict): a keep serves the entry (unless short),
// not_ad / unclear hide it on review. Run after `ai regate --backfill`, which fills the hidden entries, and after
// exporting the sheet's verdicts (export-review-verdicts.sh): an adopted item exports at the entry's bounds.
//
// An item matches an entry of its native_id's AI row (`data` or `hidden`) with its category when the entry sits
// inside the item's bounds (entryInsideSheetItem, lib/review-sheet.js). The item takes the entry's bounds, so
// later verdicts and the judge find the entry by them; its own are kept as a flagged_by line and printed. Only
// items of the old below-threshold importer are adopted (a sheet re-import would refuse others' new bounds).
// Undecided items are converted only. The latest verdict goes to the entry at the item's effective bounds (an
// earlier keep's bounds stand under a later not_ad too), where a later page verdict looks for it. One
// transaction per item under its batch row lock; an item matching no entry, or more than one, stays a sheet item.
//
// Usage: DB_NAME=… DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… \
//        node scripts/adopt-review-items.js <sheet> [--dry-run]

const { entryInsideSheetItem } = require('../lib/review-sheet');
const { scriptSequelize } = require('../lib/script-db');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');
const createAiRepository = require('../prv/repository/ai');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/adopt-review-items.js <sheet> [--dry-run]');
    process.exit(2);
}

const ROLLBACK = new Error('dry run');

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const names = args.filter((a) => a !== '--dry-run');
    if (names.length !== 1 || names[0].startsWith('-')) usage();
    const sheet = names[0];

    const sequelize = scriptSequelize();
    try {
        const models = definePrvModels(sequelize);
        const review = createReviewRepository(models, sequelize);
        const ai = createAiRepository(models, sequelize);
        const items = await review.itemsInSheet(sheet);
        if (items.length === 0) throw new Error(`no items in sheet ${sheet}`);
        const categories = new Map((await models.MarkupCategory.findAll()).map((c) => [c.id, c.category]));

        const counts = { converted: 0, applied: 0, unmatched: 0, ai: 0, other: 0, failed: 0 };
        for (const { id, batch, item_code, native_id, kind } of items) {
            if (kind !== 'sheet') {
                counts.ai++;
                continue;
            }
            let line, outcome;
            try {
                await review.withBatchLock(batch, async (transaction) => {
                    const item = await review.getItemById(id, { transaction });
                    const rows = await sequelize.query(
                        'SELECT video_id, data, hidden FROM prv_ai_video_calculateds WHERE native_id = :native_id FOR UPDATE',
                        { replacements: { native_id }, type: sequelize.QueryTypes.SELECT, transaction });
                    const found = rows.flatMap((r) => [...r.data, ...r.hidden].map((e) => ({ video_id: r.video_id, e })))
                        .filter(({ e }) => categories.get(e.category_id) === item.proposed && entryInsideSheetItem(e, item));
                    const own = `${item.start}-${item.end}`;
                    if (found.length !== 1) {
                        outcome = 'unmatched';
                        line = `${item_code}\t${native_id}\t${own}\tunmatched${found.length ? ` (${found.length} entries)` : ''}`;
                        return;
                    }
                    const [{ video_id, e }] = found;
                    if (!(await review.adoptItem(id, { video_id, start: e.start, end: e.end }, { transaction }))) {
                        outcome = item.kind === 'sheet' ? 'other' : 'ai';
                        line = `${item_code}\t${native_id}\t${own}\t${outcome === 'ai' ? 'already an ai item' : 'not a below-threshold item'}`;
                        return;
                    }
                    let what = 'no verdict';
                    let changed = false;
                    if (item.verdict) {
                        const adopted = await review.getItemById(id, { transaction });
                        changed = await ai.applyVerdict(adopted, item.verdict.verdict, { from: e, to: adopted.effective_bounds, transaction });
                        what = `${item.verdict.verdict} ${changed ? 'applied' : 'unchanged'}`;
                    }
                    outcome = changed ? 'applied' : 'converted';
                    line = `${item_code}\t${native_id}\t${own} -> video ${video_id} ${e.start}-${e.end} (${e.reason || 'served'})\t${what}`;
                    if (dryRun) throw ROLLBACK;
                });
            } catch (err) {
                if (err !== ROLLBACK) {
                    outcome = 'failed';
                    line = `${item_code}\t${native_id}\tfailed: ${err.message}`;
                }
            }
            counts[outcome]++;
            console.log(line);
        }
        console.log(`${dryRun ? 'dry run: ' : ''}${items.length} items: ${counts.converted + counts.applied} matched, ${counts.applied} applied, `
            + `${counts.unmatched} unmatched, ${counts.ai} already ai items, ${counts.other} not below-threshold items, ${counts.failed} failed`);
        if (counts.failed) process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
