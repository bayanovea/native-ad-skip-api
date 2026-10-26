// Turns the sheet items of a below-threshold sheet imported before the AI rows kept their hidden entries
// (`ai-below-threshold-2026-10-24`) into ai items on those entries, and applies each item's latest verdict to the
// AI row as a page verdict would (prv/repository/ai.js applyVerdict): a keep serves the entry (unless short),
// not_ad / unclear hide it on review. Run after `ai regate --backfill`, which fills the hidden entries.
//
// An item matches an entry of its native_id's AI row (`data` or `hidden`) with its category when the entry sits
// inside the item's bounds by less than a second at each end: the old importer kept the cue times to 0.1 s, the
// entry has them rounded inward to whole seconds. The item takes the entry's bounds, so later verdicts and the
// judge find the entry by them. Undecided items are converted only. One transaction per item under its batch row
// lock; an item matching no entry, or more than one, stays a sheet item.
//
// Usage: DB_NAME=… DB_HOST=… DB_PORT=… DB_USER=… DB_PASSWORD=… \
//        node scripts/adopt-review-items.js <sheet> [--dry-run]

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

const inside = (e, it) => e.start - it.start > -0.05 && e.start - it.start < 1.05 && it.end - e.end > -0.05 && it.end - e.end < 1.05;

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

        const counts = { matched: 0, applied: 0, unmatched: 0, ai: 0, failed: 0 };
        for (const { id, batch, item_code, native_id, kind } of items) {
            if (kind !== 'sheet') {
                counts.ai++;
                continue;
            }
            let line;
            try {
                await review.withBatchLock(batch, async (transaction) => {
                    const item = await review.getItemById(id, { transaction });
                    const rows = await sequelize.query(
                        'SELECT video_id, data, hidden FROM prv_ai_video_calculateds WHERE native_id = :native_id FOR UPDATE',
                        { replacements: { native_id }, type: sequelize.QueryTypes.SELECT, transaction });
                    const found = rows.flatMap((r) => [...r.data, ...r.hidden].map((e) => ({ video_id: r.video_id, e })))
                        .filter(({ e }) => categories.get(e.category_id) === item.proposed && inside(e, item));
                    if (found.length !== 1) {
                        counts.unmatched++;
                        line = `${item_code}\t${native_id}\t${item.start}-${item.end}\tunmatched${found.length ? ` (${found.length} entries)` : ''}`;
                        return;
                    }
                    const [{ video_id, e }] = found;
                    counts.matched++;
                    await review.adoptItem(id, { video_id, start: e.start, end: e.end }, { transaction });
                    let what = 'no verdict';
                    if (item.verdict) {
                        const adopted = await review.getItemById(id, { transaction });
                        const changed = await ai.applyVerdict(adopted, item.verdict.verdict, { from: e, to: adopted.effective_bounds, transaction });
                        if (changed) counts.applied++;
                        what = `${item.verdict.verdict} ${changed ? 'applied' : 'unchanged'}`;
                    }
                    line = `${item_code}\t${native_id}\tvideo ${video_id} ${e.start}-${e.end} (${e.reason || 'served'})\t${what}`;
                    if (dryRun) throw ROLLBACK;
                });
            } catch (err) {
                if (err !== ROLLBACK) {
                    counts.failed++;
                    line = `${item_code}\t${native_id}\tfailed: ${err.message}`;
                }
            }
            console.log(line);
        }
        console.log(`${dryRun ? 'dry run: ' : ''}${items.length} items: ${counts.matched} matched, ${counts.applied} applied, `
            + `${counts.unmatched} unmatched, ${counts.ai} already ai items, ${counts.failed} failed`);
        if (counts.failed) process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
