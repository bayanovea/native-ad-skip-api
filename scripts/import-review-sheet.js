'use strict';

// Imports a blind review sheet (`adskip sheet` output) into prv_review_items and
// prv_review_verdicts. The md file is read-only input: it is backed up first and
// never written to. Safe to re-run: items already present are kept, and md
// verdicts are imported only for items that have no verdict yet.
//
// Usage: DB_NAME=skipper DB_HOST=localhost DB_PORT=5433 DB_USER=postgres DB_PASSWORD=… \
//        node scripts/import-review-sheet.js <sheet.md> [--batch NAME]
// The key file is <sheet>.key.tsv next to the md. Tables must exist
// (sequelize.sync(): app boot or scripts/sync-db.js).

const fs = require('node:fs');
const path = require('node:path');
const { Sequelize, QueryTypes } = require('sequelize');
const { parseSheet } = require('../lib/review-sheet');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/import-review-sheet.js <sheet.md> [--batch NAME]');
    process.exit(2);
}

function parseArgs(argv) {
    let mdPath = null;
    let batch = null;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--batch') {
            batch = argv[++i];
            if (!batch) usage('--batch needs a value');
        } else if (a.startsWith('--batch=')) {
            batch = a.slice('--batch='.length);
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
    return { mdPath, batch: batch || path.basename(mdPath, '.md') };
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

async function importItems(sequelize, batch, items) {
    const summary = { inserted: [], present: [], imported: [], skipped: [] };
    await sequelize.transaction(async (transaction) => {
        for (const it of items) {
            const rows = await sequelize.query(
                `INSERT INTO prv_review_items
                    (batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by, created_at)
                 VALUES (:batch, :item_code, :position, :native_id, :start, :end, :proposed, :cues, :link, :flagged_by, NOW())
                 ON CONFLICT (batch, item_code) DO NOTHING
                 RETURNING id`,
                {
                    replacements: {
                        batch,
                        item_code: it.item_code,
                        position: it.position,
                        native_id: it.native_id,
                        start: it.start,
                        end: it.end,
                        proposed: it.proposed,
                        cues: it.cues,
                        link: it.link,
                        flagged_by: JSON.stringify(it.flagged_by),
                    },
                    type: QueryTypes.SELECT,
                    transaction,
                }
            );
            (rows.length ? summary.inserted : summary.present).push(it.item_code);
        }

        const ids = await sequelize.query(
            `SELECT i.id, i.item_code, EXISTS (SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id) AS has_verdict
               FROM prv_review_items i
              WHERE i.batch = :batch`,
            { replacements: { batch }, type: QueryTypes.SELECT, transaction }
        );
        const byCode = new Map(ids.map((r) => [r.item_code, r]));

        for (const it of items) {
            if (!it.verdict) continue;
            const row = byCode.get(it.item_code);
            if (row.has_verdict) {
                summary.skipped.push(it.item_code);
                continue;
            }
            await sequelize.query(
                `INSERT INTO prv_review_verdicts (item_id, verdict, comment, reviewer, source, decided_at)
                 VALUES (:item_id, :verdict, :comment, 'owner', 'import', NOW())`,
                {
                    replacements: { item_id: row.id, verdict: it.verdict, comment: it.comment },
                    transaction,
                }
            );
            summary.imported.push(it);
        }
    });
    return summary;
}

function printSummary(batch, summary) {
    const list = (codes) => (codes.length ? ` (${codes.join(', ')})` : '');
    console.log(`batch ${batch}`);
    console.log(`items inserted: ${summary.inserted.length}`);
    console.log(`items already present: ${summary.present.length}${list(summary.present)}`);
    console.log(`verdicts imported: ${summary.imported.length}`);
    for (const it of summary.imported) {
        console.log(`  ${it.item_code} ${it.verdict}${it.comment ? ' (with comment)' : ''}`);
    }
    console.log(`verdicts skipped, item already has one: ${summary.skipped.length}${list(summary.skipped)}`);
}

async function main() {
    const { mdPath, batch } = parseArgs(process.argv.slice(2));

    // Backup before anything else; the md is never written to.
    const backup = backupMd(mdPath);
    console.log(`backup: ${backup}`);

    const keyPath = mdPath.replace(/\.md$/, '.key.tsv');
    const md = fs.readFileSync(mdPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const { items } = parseSheet(md, key);
    if (items.length === 0) throw new Error(`${mdPath}: no items found`);

    const sequelize = new Sequelize(
        process.env.DB_NAME,
        process.env.DB_USER,
        process.env.DB_PASSWORD,
        {
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            dialect: 'postgres',
            logging: false,
            dialectOptions: { connectTimeout: 10000 },
        }
    );
    try {
        const summary = await importItems(sequelize, batch, items);
        printSummary(batch, summary);
    } finally {
        await sequelize.close();
    }
}

main().catch((e) => {
    console.error(`import failed: ${e.message}`);
    process.exit(1);
});
