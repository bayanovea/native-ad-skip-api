// Imports a blind review sheet (`adskip sheet` output) into prv_review_items and
// prv_review_verdicts. The md file is read-only input: it is backed up first and
// never written to. A sheet of more than --max-items items (default 30) is
// imported as several batches <sheet>-p1, -p2, … of near-equal size; one within
// the limit keeps the sheet name. Safe to re-run: items already in the sheet are
// kept wherever they live, new ones go to a new part, and md verdicts are
// imported only for items that have no verdict yet. A re-import whose items
// differ from the ones already in the sheet (same code, other stretch) fails and
// writes nothing.
//
// Usage: DB_NAME=skipper DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=… \
//        node scripts/import-review-sheet.js <sheet.md> [--batch NAME] [--reviewer CODE]
//        [--reviews N] [--exclude CODE[,CODE]] [--max-items N]
// --batch: sheet name (default: the md file name); parts are NAME-p1, ….
// --reviewer: who the md verdicts belong to (default bayanovea, the owner's sheets).
//   Per batch: when the imported verdicts leave it unfinished for them, it is locked
//   on them; when they finish it, their lock is released. md verdicts into a batch
//   locked by someone else fail the import.
// --reviews: how many reviewers must finish each batch (default 1).
// --exclude: reviewers who may never take its batches (they reviewed the same items
//   in another batch); md verdicts of an excluded --reviewer fail the import.
// For existing batches, --reviews / --exclude must match the stored values; a new
// part of an existing sheet takes the values of its first part unless given.
// The key file is <sheet>.key.tsv next to the md. Tables must exist
// (sequelize.sync(): app boot or scripts/sync-db.js).

const fs = require('node:fs');
const path = require('node:path');
const { parseSheet, splitSheet } = require('../lib/review-sheet');
const { scriptSequelize } = require('../lib/script-db');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-review-sheet.js <sheet.md> [--batch NAME] [--reviewer CODE]'
        + ' [--reviews N] [--exclude CODE[,CODE]] [--max-items N]');
    process.exit(2);
}

function parseArgs(argv) {
    const opts = { batch: null, reviewer: 'bayanovea', reviews: null, exclude: null, maxItems: 30 };
    let mdPath = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const m = /^--(batch|reviewer|reviews|exclude|max-items)(?:=(.*))?$/.exec(a);
        if (/^--assignee(=|$)/.test(a)) {
            usage('--assignee is gone: batches are first come, the reviewer takes one on the page');
        } else if (m) {
            const value = m[2] != null ? m[2] : argv[++i];
            if (!value) usage(`--${m[1]} needs a value`);
            if (m[1] === 'reviews' || m[1] === 'max-items') {
                if (!/^[1-9]\d*$/.test(value)) usage(`--${m[1]} needs a positive integer`);
                opts[m[1] === 'reviews' ? 'reviews' : 'maxItems'] = Number(value);
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
    const { batch, ...rest } = opts;
    return { mdPath, ...rest, sheet: batch || path.basename(mdPath, '.md') };
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

async function importItems(sequelize, review, sheet, items, { reviewer, reviews, exclude, maxItems }) {
    const summary = { parts: [], inserted: [], present: [], imported: [], skipped: [], locked: [], released: [] };
    await sequelize.transaction(async (transaction) => {
        const existing = await review.itemsInSheet(sheet, { transaction });
        const known = new Set(existing.map((r) => r.item_code));
        const oldParts = [...new Set(existing.map((r) => r.batch))];
        const newParts = splitSheet(sheet, items.filter((it) => !known.has(it.item_code)), maxItems, oldParts.length + 1);

        const batchRows = new Map();
        for (const batch of oldParts) {
            batchRows.set(batch, await review.createBatch(batch, { reviews_needed: reviews, excluded: exclude }, { transaction }));
        }
        const first = batchRows.get(oldParts[0]);
        for (const { batch } of newParts) {
            // A pre-registered empty batch row is fine; items of another sheet are not.
            if (await review.batchHasItems(batch, { transaction })) {
                throw new Error(`batch ${batch} already holds items of another sheet; nothing imported`);
            }
            batchRows.set(batch, await review.createBatch(batch, {
                reviews_needed: reviews != null ? reviews : first && first.reviews_needed,
                excluded: exclude != null ? exclude : first && first.excluded,
            }, { transaction }));
        }
        const holders = new Map();
        for (const batch of batchRows.keys()) holders.set(batch, await review.lockBatchRow(batch, { transaction }));

        summary.present = items.filter((it) => known.has(it.item_code)).map((it) => it.item_code);
        for (const { batch, items: partItems } of newParts) {
            const { inserted, present } = await review.insertItems(sheet, batch, partItems, { transaction });
            summary.inserted.push(...inserted);
            summary.present.push(...present);
        }

        const rows = await review.itemsInSheet(sheet, { transaction });
        const byCode = new Map(rows.map((r) => [r.item_code, r]));
        summary.parts = [...batchRows.keys()].map((batch) => ({ batch, total: rows.filter((r) => r.batch === batch).length }));

        // An item already in the sheet must be the same stretch as the md block;
        // otherwise (sheet regenerated under the same name, --batch pointing at
        // another sheet) md verdicts would land on the wrong item.
        for (const it of items) {
            const row = byCode.get(it.item_code);
            const diff = ['native_id', 'start', 'end', 'proposed'].filter((f) => row[f] !== it[f]);
            if (diff.length) {
                throw new Error(`${it.item_code}: batch ${row.batch} already has a different item under this code `
                    + `(${diff.map((f) => `${f} ${row[f]} ≠ ${it[f]}`).join(', ')}); nothing imported`);
            }
        }

        const touched = new Set();
        for (const it of items) {
            if (!it.verdict) continue;
            const row = byCode.get(it.item_code);
            if (row.has_verdict) {
                summary.skipped.push(it.item_code);
                continue;
            }
            const holder = holders.get(row.batch);
            if (batchRows.get(row.batch).excluded.includes(reviewer)) {
                throw new Error(`batch ${row.batch} excludes ${reviewer}: their md verdicts may not land there; nothing imported`);
            }
            if (holder != null && holder !== reviewer) {
                throw new Error(`batch ${row.batch} is locked by ${holder}: ${reviewer}'s md verdicts may not land there; nothing imported`);
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
            touched.add(row.batch);
        }
        // Only batches with new verdicts: a re-run must not re-lock a batch the reviewer gave up.
        for (const batch of touched) {
            if ((await review.lockIfAvailable(batch, reviewer, { transaction })) != null) summary.locked.push(batch);
            if (await review.releaseIfFinished(batch, reviewer, { transaction })) summary.released.push(batch);
        }
    });
    return summary;
}

function printSummary(sheet, summary, reviewer) {
    const list = (codes) => (codes.length ? ` (${codes.join(', ')})` : '');
    console.log(`sheet ${sheet}: ${summary.parts.map((p) => `batch ${p.batch} (${p.total} items)`).join(', ')}`);
    console.log(`items inserted: ${summary.inserted.length}`);
    console.log(`items already present: ${summary.present.length}${list(summary.present)}`);
    console.log(`verdicts imported: ${summary.imported.length}`);
    for (const it of summary.imported) {
        console.log(`  ${it.item_code} ${it.verdict}${it.comment ? ' (with comment)' : ''}`);
    }
    console.log(`verdicts skipped, item already has one: ${summary.skipped.length}${list(summary.skipped)}`);
    for (const batch of summary.locked) console.log(`batch ${batch}: locked on ${reviewer}: their verdicts leave the batch unfinished`);
    for (const batch of summary.released) console.log(`batch ${batch}: lock released: ${reviewer} has finished the batch`);
}

async function main() {
    const { mdPath, sheet, reviewer, reviews, exclude, maxItems } = parseArgs(process.argv.slice(2));

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
        const summary = await importItems(sequelize, review, sheet, items, { reviewer, reviews, exclude, maxItems });
        printSummary(sheet, summary, reviewer);
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(`import failed: ${e.message}`);
    process.exit(1);
});
