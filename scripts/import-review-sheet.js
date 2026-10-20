'use strict';

// Imports a blind review sheet (`adskip sheet` output) into prv_review_items and
// prv_review_verdicts. The md file is read-only input: it is backed up first and
// never written to. Safe to re-run: items already present are kept, and md
// verdicts are imported only for items that have no verdict yet. A re-import
// whose items differ from the ones already in the batch (same code, other
// stretch) fails and writes nothing.
//
// Usage: DB_NAME=skipper DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=… \
//        node scripts/import-review-sheet.js <sheet.md> [--batch NAME] [--reviewer CODE]
//        [--reviews N] [--exclude CODE[,CODE]]
// --reviewer: who the md verdicts belong to (default bayanovea, the owner's sheets).
//   When the imported verdicts leave the batch unfinished for them, it is locked on them;
//   when they finish it, their lock is released.
// --reviews: how many reviewers must finish the batch (default 1).
// --exclude: reviewers who may never take it (they reviewed the same items in another batch);
//   md verdicts of an excluded --reviewer fail the import.
// For an existing batch, --reviews / --exclude must match the stored values.
// The key file is <sheet>.key.tsv next to the md. Tables must exist
// (sequelize.sync(): app boot or scripts/sync-db.js).

const fs = require('node:fs');
const path = require('node:path');
const { parseSheet } = require('../lib/review-sheet');
const { scriptSequelize } = require('../lib/script-db');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-review-sheet.js <sheet.md> [--batch NAME] [--reviewer CODE]'
        + ' [--reviews N] [--exclude CODE[,CODE]]');
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { batch: null, reviewer: 'bayanovea', reviews: undefined, exclude: undefined };
    let mdPath = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const m = /^--(batch|reviewer|reviews|exclude)(?:=(.*))?$/.exec(a);
        if (/^--assignee(=|$)/.test(a)) {
            usage('--assignee is gone: batches are first come, the reviewer takes one on the page');
        } else if (m) {
            const value = m[2] != null ? m[2] : argv[++i];
            if (!value) usage(`--${m[1]} needs a value`);
            if (m[1] === 'reviews') {
                if (!/^[1-9]\d*$/.test(value)) usage('--reviews needs a positive integer');
                opts.reviews = Number(value);
            } else if (m[1] === 'exclude') {
                opts.exclude = value.split(',').map((c) => c.trim()).filter(Boolean);
                if (opts.exclude.length === 0) usage('--exclude needs reviewer codes');
            } else {
                opts[m[1]] = value;
            }
        } else if (a.startsWith('-')) {
            usage(`unknown option ${a}`);
        } else if (!mdPath) {
            mdPath = a;
        } else {
            usage(`unexpected argument ${a}`);
        }
    }
    if (!mdPath) usage();
    if (!mdPath.endsWith('.md')) usage(`${mdPath}: expected a .md file`);
    return { mdPath, ...opts, batch: opts.batch || path.basename(mdPath, '.md') };
}

function timestamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Copy the md to <md>.bak-YYYYMMDDHHMMSS; never overwrite an existing backup
// (two runs in the same second get a -1, -2, … suffix).
function backupMd(mdPath) {
    const base = `${mdPath}.bak-${timestamp()}`;
    for (let n = 0; ; n++) {
        const dst = n === 0 ? base : `${base}-${n}`;
        try {
            fs.copyFileSync(mdPath, dst, fs.constants.COPYFILE_EXCL);
            return dst;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
    }
}

async function importItems(sequelize, review, batch, items, { reviewer, reviews, exclude }) {
    const summary = { inserted: [], present: [], imported: [], skipped: [], locked: false, released: false };
    await sequelize.transaction(async (transaction) => {
        const batchRow = await review.createBatch(batch, { reviews_needed: reviews, excluded: exclude }, { transaction });
        const { inserted, present } = await review.insertItems(batch, items, { transaction });
        summary.inserted = inserted;
        summary.present = present;

        const ids = await review.itemsInBatch(batch, { transaction });
        const byCode = new Map(ids.map((r) => [r.item_code, r]));

        // An item already in the batch must be the same stretch as the md block;
        // otherwise (sheet regenerated under the same name, --batch pointing at
        // another sheet's batch) md verdicts would land on the wrong item.
        for (const it of items) {
            const row = byCode.get(it.item_code);
            const diff = ['native_id', 'start', 'end', 'proposed'].filter((f) => row[f] !== it[f]);
            if (diff.length) {
                throw new Error(`${it.item_code}: batch ${batch} already has a different item under this code `
                    + `(${diff.map((f) => `${f} ${row[f]} ≠ ${it[f]}`).join(', ')}); nothing imported`);
            }
        }

        for (const it of items) {
            if (!it.verdict) continue;
            const row = byCode.get(it.item_code);
            if (row.has_verdict) {
                summary.skipped.push(it.item_code);
                continue;
            }
            if (batchRow.excluded.includes(reviewer)) {
                throw new Error(`batch ${batch} excludes ${reviewer}: their md verdicts may not land there; nothing imported`);
            }
            await review.recordVerdict({
                item_id: row.id,
                verdict: it.verdict,
                comment: it.comment,
                reviewer,
                source: 'import',
                transaction,
            });
            summary.imported.push(it);
        }
        // Only after new verdicts: a re-run must not re-lock a batch the reviewer gave up.
        if (summary.imported.length) {
            summary.locked = await review.lockUnfinished(batch, reviewer, { transaction });
            summary.released = await review.releaseIfFinished(batch, reviewer, { transaction });
        }
    });
    return summary;
}

function printSummary(batch, summary, reviewer) {
    const list = (codes) => (codes.length ? ` (${codes.join(', ')})` : '');
    console.log(`batch ${batch}`);
    console.log(`items inserted: ${summary.inserted.length}`);
    console.log(`items already present: ${summary.present.length}${list(summary.present)}`);
    console.log(`verdicts imported: ${summary.imported.length}`);
    for (const it of summary.imported) {
        console.log(`  ${it.item_code} ${it.verdict}${it.comment ? ' (with comment)' : ''}`);
    }
    console.log(`verdicts skipped, item already has one: ${summary.skipped.length}${list(summary.skipped)}`);
    if (summary.locked) console.log(`locked on ${reviewer}: their verdicts leave the batch unfinished`);
    if (summary.released) console.log(`lock released: ${reviewer} has finished the batch`);
}

async function main() {
    const { mdPath, batch, reviewer, reviews, exclude } = parseArgs(process.argv.slice(2));

    // Backup before anything else; the md is never written to.
    const backup = backupMd(mdPath);
    console.log(`backup: ${backup}`);

    const keyPath = mdPath.replace(/\.md$/, '.key.tsv');
    const md = fs.readFileSync(mdPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const { items } = parseSheet(md, key);
    if (items.length === 0) throw new Error(`${mdPath}: no items found`);

    const sequelize = scriptSequelize();
    try {
        // All review-table SQL lives in the repository; verdicts go through the
        // same write entrypoint as the review page.
        const review = createReviewRepository(definePrvModels(sequelize), sequelize);
        const summary = await importItems(sequelize, review, batch, items, { reviewer, reviews, exclude });
        printSummary(batch, summary, reviewer);
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(`import failed: ${e.message}`);
    process.exit(1);
});
