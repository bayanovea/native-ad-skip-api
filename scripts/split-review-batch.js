// Splits a review batch of more than --max-items items (default 30) into
// batches <batch>-p1, -p2, … of near-equal size in position order, the way the
// importer cuts a large sheet. One transaction: the parts get the batch's
// reviews_needed / excluded, the items move (verdicts stay on them, and the
// items keep their sheet, so re-import and export by sheet name still work),
// the old batch row is deleted. Refuses a locked batch (release it on the page
// first), one within the limit and one whose part names exist.
//
// Usage: DB_NAME=skipper DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=… \
//        node scripts/split-review-batch.js <batch> [--max-items N]

const { scriptSequelize } = require('../lib/script-db');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/split-review-batch.js <batch> [--max-items N]');
    process.exit(2);
}

function parseArgs(argv) {
    let batch = null;
    let maxItems = 30;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const m = /^--max-items(?:=(.*))?$/.exec(a);
        if (m) {
            const value = m[1] != null ? m[1] : argv[++i];
            if (!value || !/^[1-9]\d*$/.test(value)) usage('--max-items needs a positive integer');
            maxItems = Number(value);
        } else if (a.startsWith('-')) {
            usage(`unknown option ${a}`);
        } else if (!batch) {
            batch = a;
        } else {
            usage(`unexpected argument ${a}`);
        }
    }
    if (!batch) usage();
    return { batch, maxItems };
}

async function main() {
    const { batch, maxItems } = parseArgs(process.argv.slice(2));
    const sequelize = scriptSequelize();
    try {
        const review = createReviewRepository(definePrvModels(sequelize), sequelize);
        const { sheet, total, parts } = await review.splitBatch(batch, maxItems);
        console.log(`batch ${batch} (${total} items, sheet ${sheet}) split into `
            + parts.map((p) => `${p.batch} (${p.total} items)`).join(', '));
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(`split failed: ${e.message}`);
    process.exit(1);
});
