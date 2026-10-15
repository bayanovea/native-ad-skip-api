'use strict';

/*
 * Tests scripts/export-review-verdicts.sql (assessor verdicts → `adskip review -file` TSV).
 *
 * The export is plain SQL run by psql (scripts/export-review-verdicts.sh). psql is not in
 * the e2e container, so the test runs the same file through the Sequelize connection:
 * the psql meta-command lines (`\…`) are dropped and :'batch' is bound as $1. The output
 * lines are joined with "\n" plus a trailing newline, exactly as psql writes them in
 * unaligned tuples-only mode.
 *
 * Harness as in test/moderation-resolver.test.js: a dedicated DB
 * (`${DB_NAME}_unit_review_export`), schema from Sequelize.sync(), raw SQL seeds,
 * dropped on teardown. Runs under `make test-e2e`; standalone:
 *   DB_HOST=… DB_USER=… DB_PASSWORD=… DB_NAME=… node --test test/review-export.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const BASE_DB = process.env.DB_NAME;
const TEST_DB = `${BASE_DB}_unit_review_export`;

const SQL_FILE = path.join(__dirname, '..', 'scripts', 'export-review-verdicts.sql');

let sequelize;

function adminClient(dbName = 'postgres') {
    return new Client({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: dbName });
}

// The .sql file as one plain statement: psql meta-commands dropped, :'batch' → $1.
function exportQuery() {
    const sql = fs.readFileSync(SQL_FILE, 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('\\'))
        .join('\n')
        .replace(/:'batch'/g, '$1')
        .trim()
        .replace(/;$/, '');
    assert.ok(!sql.includes(':\''), 'unhandled psql variable in export SQL');
    return sql;
}

async function exportTsv(batch) {
    const [rows] = await sequelize.query(exportQuery(), { bind: [batch] });
    return rows.map((r) => r.line).join('\n') + '\n';
}

async function q(sql, bind = []) {
    const [rows] = await sequelize.query(sql, { bind });
    return rows;
}

async function addItem(batch, code, position, nativeId, start, end, proposed) {
    const [row] = await q(
        `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'cues', 'https://example.invalid/video', '["run-a"]', NOW()) RETURNING id`,
        [batch, code, position, nativeId, start, end, proposed]);
    return row.id;
}

async function addVerdict(itemId, verdict, comment, decidedAt) {
    await q(
        `INSERT INTO prv_review_verdicts (item_id, verdict, comment, reviewer, source, decided_at)
         VALUES ($1, $2, $3, 'owner', 'page', $4)`,
        [itemId, verdict, comment, decidedAt]);
}

before(async () => {
    assert.ok(DB_USER && BASE_DB, 'DB_USER / DB_NAME must be set (run via make test-e2e)');
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.query(`CREATE DATABASE "${TEST_DB}"`);
    await c.end();

    const { Sequelize } = require('sequelize');
    sequelize = new Sequelize(TEST_DB, DB_USER, DB_PASSWORD, {
        host: DB_HOST, port: DB_PORT, dialect: 'postgres', logging: false,
    });
    require('../prv/db')(sequelize);
    await sequelize.sync();
});

after(async () => {
    if (sequelize) await sequelize.close();
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.end();
});

test('review export: mapping, latest verdict wins, open items skipped, note sanitised, ordered by position', async () => {
    const b = 'export-basic';
    // Inserted out of position order on purpose.
    const c10 = await addItem(b, 'C10', 10, '-10_10', 600, 615.34, 'self_promotion');
    const c1 = await addItem(b, 'C1', 1, '-1_1', 62.2, 78.3, 'self_promotion');
    const c2 = await addItem(b, 'C2', 2, '-2_2', 262.4, 269, 'sponsor');
    const c3 = await addItem(b, 'C3', 3, '-3_3', 1801.9, 1832.6, 'sponsor+self_promotion');
    const c4 = await addItem(b, 'C4', 4, '-4_4', 5, 9.5, 'self_promotion+sponsor');
    await addItem(b, 'C5', 5, '-5_5', 100, 110, 'sponsor');                  // open: skipped
    const c6 = await addItem(b, 'C6', 6, '-6_6', 3378.6, 3479.9, 'sponsor');

    await addVerdict(c1, 'self_promotion', null, '2026-10-15T10:00:00Z');
    // Changed verdict: the later row wins, whatever the insert order.
    await addVerdict(c2, 'not_ad', 'later', '2026-10-15T12:00:00Z');
    await addVerdict(c2, 'sponsor', 'earlier', '2026-10-15T11:00:00Z');
    // Comment with a newline and a tab.
    await addVerdict(c3, 'not_ad', 'Это не реклама,\nпросто\tупоминание  ', '2026-10-15T10:00:00Z');
    await addVerdict(c4, 'unclear', '', '2026-10-15T10:00:00Z');
    await addVerdict(c6, 'sponsor', 'host reads\r\n\r\nthe ad', '2026-10-15T10:00:00Z');
    await addVerdict(c10, 'self_promotion', 'own channel', '2026-10-15T10:00:00Z');

    // Another batch with the same item codes stays out.
    const other = await addItem('export-other', 'C1', 1, '-99_99', 1, 2, 'sponsor');
    await addVerdict(other, 'sponsor', null, '2026-10-15T10:00:00Z');

    const expected = [
        'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote',
        'prv\t-1_1\tself_promotion\t62.2\t78.3\tgold_missing\tC1\t',
        'prv\t-2_2\tsponsor\t262.4\t269.0\tmodel_wrong\tC2\tlater',
        'prv\t-3_3\tsponsor\t1801.9\t1832.6\tmodel_wrong\tC3\tЭто не реклама, просто упоминание',
        'prv\t-4_4\tself_promotion\t5.0\t9.5\tdefinition_unclear\tC4\t',
        'prv\t-6_6\tsponsor\t3378.6\t3479.9\tgold_missing\tC6\thost reads the ad',
        'prv\t-10_10\tself_promotion\t600.0\t615.3\tgold_missing\tC10\town channel',
    ].join('\n') + '\n';
    assert.equal(await exportTsv(b), expected);
});

test('review export: batch without verdicts yields the header only', async () => {
    await addItem('export-open', 'C1', 1, '-7_7', 10, 20, 'sponsor');
    assert.equal(await exportTsv('export-open'), 'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n');
    assert.equal(await exportTsv('export-no-such-batch'), 'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n');
});
