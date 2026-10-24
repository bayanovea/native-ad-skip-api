'use strict';

/*
 * Tests scripts/export-review-verdicts.sql (assessor verdicts → `adskip review -file` TSV).
 *
 * The export is plain SQL run by psql (scripts/export-review-verdicts.sh). The mapping
 * tests run the same file through the Sequelize connection: the psql meta-command lines
 * (`\…`) are dropped, :'batch' is bound as $1 and :'reviewer' as $2, and the output lines are joined with
 * "\n" plus a trailing newline, as psql writes them in unaligned tuples-only mode. The
 * last test runs the real .sh through psql (installed in the e2e image only, see
 * docker-compose.e2e.yml) and checks it writes exactly that text.
 *
 * Harness as in test/moderation-resolver.test.js: a dedicated DB
 * (`${DB_NAME}_unit_review_export`), schema from Sequelize.sync(), raw SQL seeds,
 * dropped on teardown. Runs under `make test-e2e`; standalone:
 *   DB_HOST=… DB_USER=… DB_PASSWORD=… DB_NAME=… node --test test/review-export.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const BASE_DB = process.env.DB_NAME;
const TEST_DB = `${BASE_DB}_unit_review_export`;

const SQL_FILE = path.join(__dirname, '..', 'scripts', 'export-review-verdicts.sql');
const SH_FILE = path.join(__dirname, '..', 'scripts', 'export-review-verdicts.sh');

let sequelize;

function adminClient(dbName = 'postgres') {
    return new Client({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: dbName });
}

// The .sql file as one plain statement: psql meta-commands dropped, :'batch' → $1, :'reviewer' → $2.
function exportQuery() {
    const sql = fs.readFileSync(SQL_FILE, 'utf8')
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('\\'))
        .join('\n')
        .replace(/:'batch'/g, '$1')
        .replace(/:'reviewer'/g, '$2')
        .trim()
        .replace(/;$/, '');
    assert.ok(!sql.includes(':\''), 'unhandled psql variable in export SQL');
    return sql;
}

async function exportTsv(batch, reviewer = '') {
    const [rows] = await sequelize.query(exportQuery(), { bind: [batch, reviewer] });
    return rows.map((r) => r.line).join('\n') + '\n';
}

async function q(sql, bind = []) {
    const [rows] = await sequelize.query(sql, { bind });
    return rows;
}

async function addItem(batch, code, position, nativeId, start, end, proposed) {
    const [row] = await q(
        `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'cues', 'https://example.invalid/video', '["run-a"]') RETURNING id`,
        [batch, code, position, nativeId, start, end, proposed]);
    return row.id;
}

async function addVerdict(itemId, verdict, comment, decidedAt, reviewer = 'owner') {
    await q(
        `INSERT INTO prv_review_verdicts (item_id, verdict, comment, reviewer, source, decided_at)
         VALUES ($1, $2, $3, $4, 'page', $5)`,
        [itemId, verdict, comment, reviewer, decidedAt]);
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

async function addBoundsVerdict(itemId, verdict, decidedAt, start, end, reviewer = 'owner') {
    await q(
        `INSERT INTO prv_review_verdicts (item_id, verdict, comment, reviewer, source, start, "end", bounds_source, decided_at)
         VALUES ($1, $2, NULL, $3, 'page', $4, $5, 'typed', $6)`,
        [itemId, verdict, reviewer, start, end, decidedAt]);
}

test('review export: a keep verdict exports the corrected bounds, a later keep without bounds keeps them, other verdicts the item\'s', async () => {
    const b = 'export-bounds';
    const c1 = await addItem(b, 'C1', 1, '-21_21', 100, 130, 'sponsor');
    const c2 = await addItem(b, 'C2', 2, '-22_22', 200, 230, 'sponsor');
    const c3 = await addItem(b, 'C3', 3, '-23_23', 300, 330, 'sponsor');
    const c4 = await addItem(b, 'C4', 4, '-24_24', 400, 430, 'sponsor');
    await addBoundsVerdict(c1, 'sponsor', '2026-10-15T10:00:00Z', 95, 140);
    await addBoundsVerdict(c2, 'sponsor', '2026-10-15T10:00:00Z', 190, 235);
    await addVerdict(c2, 'self_promotion', null, '2026-10-15T11:00:00Z');
    await addBoundsVerdict(c3, 'sponsor', '2026-10-15T10:00:00Z', 290, 335);
    await addVerdict(c3, 'not_ad', null, '2026-10-15T11:00:00Z');
    await addVerdict(c4, 'sponsor', null, '2026-10-15T10:00:00Z');
    // Another reviewer's bounds stay out of a per-reviewer export.
    await addBoundsVerdict(c4, 'sponsor', '2026-10-15T09:00:00Z', 395, 440, 'gkshi');

    const header = 'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n';
    assert.equal(await exportTsv(b), header
        + 'prv\t-21_21\tsponsor\t95.0\t140.0\tgold_missing\tC1\t\n'
        + 'prv\t-22_22\tself_promotion\t190.0\t235.0\tgold_missing\tC2\t\n'
        + 'prv\t-23_23\tsponsor\t300.0\t330.0\tmodel_wrong\tC3\t\n'
        + 'prv\t-24_24\tsponsor\t395.0\t440.0\tgold_missing\tC4\t\n');
    assert.equal(await exportTsv(b, 'owner'), header
        + 'prv\t-21_21\tsponsor\t95.0\t140.0\tgold_missing\tC1\t\n'
        + 'prv\t-22_22\tself_promotion\t190.0\t235.0\tgold_missing\tC2\t\n'
        + 'prv\t-23_23\tsponsor\t300.0\t330.0\tmodel_wrong\tC3\t\n'
        + 'prv\t-24_24\tsponsor\t400.0\t430.0\tgold_missing\tC4\t\n');
});

test('review export: batch without verdicts yields the header only', async () => {
    await addItem('export-open', 'C1', 1, '-7_7', 10, 20, 'sponsor');
    assert.equal(await exportTsv('export-open'), 'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n');
    assert.equal(await exportTsv('export-no-such-batch'), 'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n');
});

test('review export: same decided_at → the higher id wins', async () => {
    const b = 'export-tie';
    const c1 = await addItem(b, 'C1', 1, '-8_8', 10, 20, 'sponsor');
    await addVerdict(c1, 'sponsor', 'first', '2026-10-15T10:00:00Z');
    await addVerdict(c1, 'not_ad', 'second', '2026-10-15T10:00:00Z');
    assert.equal(await exportTsv(b),
        'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n'
        + 'prv\t-8_8\tsponsor\t10.0\t20.0\tmodel_wrong\tC1\tsecond\n');
});

test('review export: a reviewer narrows to their latest verdict per item, the others stay out', async () => {
    const b = 'export-reviewer';
    const c1 = await addItem(b, 'C1', 1, '-11_11', 10, 20, 'sponsor');
    const c2 = await addItem(b, 'C2', 2, '-12_12', 30, 40, 'sponsor');
    await addVerdict(c1, 'sponsor', 'mine, earlier', '2026-10-15T10:00:00Z', 'Анна');
    await addVerdict(c1, 'not_ad', 'mine, later', '2026-10-15T11:00:00Z', 'Анна');
    await addVerdict(c1, 'unclear', 'owner, latest', '2026-10-15T12:00:00Z');
    await addVerdict(c2, 'sponsor', 'owner only', '2026-10-15T10:00:00Z');

    const header = 'provider\tnative_id\tcategory\tstart\tend\tverdict\titem\tnote\n';
    assert.equal(await exportTsv(b, 'Анна'), header + 'prv\t-11_11\tsponsor\t10.0\t20.0\tmodel_wrong\tC1\tmine, later\n');
    assert.equal(await exportTsv(b), header
        + 'prv\t-11_11\tsponsor\t10.0\t20.0\tdefinition_unclear\tC1\towner, latest\n'
        + 'prv\t-12_12\tsponsor\t30.0\t40.0\tgold_missing\tC2\towner only\n');
    assert.equal(await exportTsv(b, 'nobody'), header);
});

test('review export: the .sh wrapper writes the same TSV through psql, a reviewer file, refuses an unknown batch or reviewer', async () => {
    const b = 'export-sh';
    const c1 = await addItem(b, 'C1', 1, '-9_9', 30, 45.5, 'self_promotion');
    await addItem(b, 'C2', 2, '-9_9', 60, 70, 'sponsor');                    // open
    await addVerdict(c1, 'unclear', 'line one\nline two', '2026-10-15T10:00:00Z');
    await addVerdict(c1, 'sponsor', null, '2026-10-15T09:00:00Z', 'gkshi');
    await addVerdict(c1, 'not_ad', 'анна', '2026-10-15T08:00:00Z', 'Анна П');
    await q("INSERT INTO prv_review_reviewers (code) VALUES ('gkshi'), ('Анна П')");

    // Data root without a review/ dir: the script creates it. A space in the
    // path checks that psql's `\o :out` keeps the value as one argument.
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'review export '));
    try {
        const run = (...args) => spawnSync('sh', [SH_FILE, ...args], {
            encoding: 'utf8',
            env: {
                ...process.env, ADSKIP_DATA: data,
                PGHOST: DB_HOST, PGPORT: String(DB_PORT), PGUSER: DB_USER, PGPASSWORD: DB_PASSWORD, PGDATABASE: TEST_DB,
            },
        });
        const out = path.join(data, 'review', `${b}.verdicts.tsv`);

        const r = run(b);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), `wrote ${out}: 1 verdicts of 2 items`);
        assert.equal(fs.readFileSync(out, 'utf8'), await exportTsv(b));
        assert.match(fs.readFileSync(out, 'utf8'), /\tC1\tline one line two\n$/);

        const r2 = run(b, 'owner');
        assert.equal(r2.status, 1, 'owner is not a registered reviewer');
        assert.match(r2.stderr, /unknown reviewer owner/);

        const mine = path.join(data, 'review', `${b}.gkshi.verdicts.tsv`);
        const r3 = run(b, 'gkshi');
        assert.equal(r3.status, 0, r3.stderr);
        assert.equal(r3.stdout.trim(), `wrote ${mine}: 1 verdicts of 2 items`);
        assert.equal(fs.readFileSync(mine, 'utf8'), await exportTsv(b, 'gkshi'));
        assert.match(fs.readFileSync(mine, 'utf8'), /\tgold_missing\tC1\t\n$/);
        // A Cyrillic code with a space: one file name, one psql variable.
        const anna = path.join(data, 'review', `${b}.Анна П.verdicts.tsv`);
        const r4 = run(b, 'Анна П');
        assert.equal(r4.status, 0, r4.stderr);
        assert.equal(r4.stdout.trim(), `wrote ${anna}: 1 verdicts of 2 items`);
        assert.equal(fs.readFileSync(anna, 'utf8'), await exportTsv(b, 'Анна П'));
        assert.match(fs.readFileSync(anna, 'utf8'), /\tmodel_wrong\tC1\tанна\n$/);
        const files = () => fs.readdirSync(path.join(data, 'review')).sort();
        const written = [`${b}.gkshi.verdicts.tsv`, `${b}.verdicts.tsv`, `${b}.Анна П.verdicts.tsv`].sort();
        assert.deepEqual(files(), written, 'no temp file left');

        const bad = run('export-no-such-batch');
        assert.equal(bad.status, 1);
        assert.match(bad.stderr, /unknown sheet or batch export-no-such-batch/);
        assert.equal(run('a', 'b', 'c').status, 2);
        assert.deepEqual(files(), written, 'nothing written');
    } finally {
        fs.rmSync(data, { recursive: true, force: true });
    }
});

test('review export: a split sheet exports the same TSV under its name; a part exports its own items', async () => {
    const b = 'export-split';
    await q("INSERT INTO prv_review_reviewers (code) VALUES ('gkshi') ON CONFLICT DO NOTHING");
    await q(`INSERT INTO prv_review_batches (batch) VALUES ('${b}')`);
    // No sheet column value, as on rows imported before sheets existed.
    for (let k = 1; k <= 64; k++) {
        const id = await addItem(b, `C${k}`, k, `-1_${k}`, 10 * k, 10 * k + 5, 'sponsor');
        if (k % 2 === 0) await addVerdict(id, 'not_ad', `owner ${k}`, '2026-10-15T10:00:00Z');
        if (k <= 30) await addVerdict(id, 'sponsor', null, '2026-10-15T11:00:00Z', 'gkshi');
    }
    const whole = await exportTsv(b);
    const gkshi = await exportTsv(b, 'gkshi');
    assert.equal(whole.split('\n').length - 2, 47);

    const split = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'split-review-batch.js'), b], {
        encoding: 'utf8', env: { ...process.env, DB_NAME: TEST_DB, DB_HOST, DB_PORT: String(DB_PORT) } });
    assert.equal(split.status, 0, split.stderr);
    assert.deepEqual((await q('SELECT DISTINCT batch, sheet FROM prv_review_items WHERE sheet = $1 ORDER BY batch', [b]))
        .map((r) => r.batch), [`${b}-p1`, `${b}-p2`, `${b}-p3`]);

    assert.equal(await exportTsv(b), whole);
    assert.equal(await exportTsv(b, 'gkshi'), gkshi);
    const lines = whole.split('\n');
    assert.equal(await exportTsv(`${b}-p1`), [lines[0], ...lines.slice(1).filter((l) => /\tC([1-9]|1\d|2[0-2])\t/.test(l)), ''].join('\n'));

    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'review-export-split-'));
    try {
        const r = spawnSync('sh', [SH_FILE, b], {
            encoding: 'utf8',
            env: {
                ...process.env, ADSKIP_DATA: data,
                PGHOST: DB_HOST, PGPORT: String(DB_PORT), PGUSER: DB_USER, PGPASSWORD: DB_PASSWORD, PGDATABASE: TEST_DB,
            },
        });
        assert.equal(r.status, 0, r.stderr);
        const out = path.join(data, 'review', `${b}.verdicts.tsv`);
        assert.equal(r.stdout.trim(), `wrote ${out}: 47 verdicts of 64 items`);
        assert.equal(fs.readFileSync(out, 'utf8'), whole);
    } finally {
        fs.rmSync(data, { recursive: true, force: true });
    }
});

test('import-verdict-bounds: appends a copy of the reviewer\'s keep verdict with the bounds, skips what cannot be bounds, a bad line writes nothing', async () => {
    const b = 'bounds-import';
    await q("INSERT INTO prv_review_reviewers (code) VALUES ('gkshi'), ('owner') ON CONFLICT DO NOTHING");
    await q(`INSERT INTO prv_review_batches (batch) VALUES ('${b}')`);
    const c1 = await addItem(b, 'C1', 1, '-31_31', 1391.7, 1412, 'sponsor');
    const c2 = await addItem(b, 'C2', 2, '-32_32', 100, 130, 'sponsor');
    const c3 = await addItem(b, 'C3', 3, '-33_33', 200, 230, 'sponsor');
    const c4 = await addItem(b, 'C4', 4, '-34_34', 300, 330, 'sponsor');
    await addItem(b, 'C5', 5, '-35_35', 400, 430, 'sponsor');
    const c6 = await addItem(b, 'C6', 6, '-36_36', 500, 530, 'sponsor');
    await addVerdict(c1, 'sponsor', 'реклама началась раньше 23:01', '2026-10-15T10:00:00Z', 'gkshi');
    await addVerdict(c2, 'not_ad', 'the ad starts at 1:30', '2026-10-15T10:00:00Z', 'gkshi');
    await addVerdict(c3, 'sponsor', null, '2026-10-15T10:00:00Z', 'gkshi');
    await addVerdict(c3, 'not_ad', null, '2026-10-15T11:00:00Z', 'owner');
    await addVerdict(c4, 'self_promotion', null, '2026-10-15T10:00:00Z', 'gkshi');
    await addBoundsVerdict(c6, 'sponsor', '2026-10-15T10:00:00Z', 495, 535, 'gkshi');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-import-'));
    const run = (text, ...args) => {
        const file = path.join(dir, 'bounds.tsv');
        fs.writeFileSync(file, text);
        return spawnSync('node', [path.join(__dirname, '..', 'scripts', 'import-verdict-bounds.js'), file, ...args], {
            encoding: 'utf8', env: { ...process.env, DB_NAME: TEST_DB, DB_HOST, DB_PORT: String(DB_PORT) } });
    };
    const rows = async (id) => q('SELECT verdict, comment, reviewer, source, start, "end", bounds_source FROM prv_review_verdicts WHERE item_id = $1 ORDER BY id', [id]);
    try {
        const tsv = [
            'sheet\titem_code\treviewer\tstart\tend',
            '# checked by the owner',
            `${b}\tC1\tgkshi\t23:01\t23:32`,
            `${b}\tC2\tgkshi\t1:30\t2:10`,
            `${b}\tC3\tgkshi\t3:10\t3:55`,
            `${b}\tC4\t-\t5:00\t5:03`,
            `${b}\tC5\t-\t6:40\t7:10`,
            `${b}\tC6\tgkshi\t495\t535`,
            '',
        ].join('\n');
        const dry = run(tsv, '--dry-run');
        assert.equal(dry.status, 0, dry.stderr);
        assert.match(dry.stdout, /would apply bounds-import C1 gkshi 1381-1412/);
        assert.match(dry.stdout, /dry run: 1 applied, 5 skipped/);
        assert.equal((await rows(c1)).length, 1, 'a dry run writes nothing');

        const r = run(tsv);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.stdout.trim().split('\n'), [
            'applied bounds-import C1 gkshi 1381-1412',
            'skipped bounds-import C2 gkshi 90-130: latest verdict is not_ad, not a keep',
            'skipped bounds-import C3 gkshi 190-235: a later verdict by owner',
            'skipped bounds-import C4 gkshi 300-303: bounds 300-303: short',
            'skipped bounds-import C5 - 400-430: no verdict by anyone',
            'skipped bounds-import C6 gkshi 495-535: already has these bounds',
            '1 applied, 5 skipped',
        ]);
        assert.deepEqual((await rows(c1)).at(-1), { verdict: 'sponsor', comment: 'реклама началась раньше 23:01', reviewer: 'gkshi',
            source: 'import', start: 1381, end: 1412, bounds_source: 'import' });
        assert.equal(await exportTsv(b).then((t) => t.split('\n')[1]), 'prv\t-31_31\tsponsor\t1381.0\t1412.0\tgold_missing\tC1\tреклама началась раньше 23:01');

        for (const bad of [`${b}\tC1\tgkshi\t23:01`, `${b}\tC1\tgkshi\t23-01\t23:32`, `${b}\tC9\tgkshi\t1:00\t2:00`, `${b}\tC1\tnobody\t1:00\t2:00`]) {
            const before = (await rows(c1)).length;
            const e = run(`${b}\tC4\tgkshi\t5:00\t5:30\n${bad}\n`);
            assert.equal(e.status, 1, bad);
            assert.match(e.stderr, /import failed: /);
            assert.equal((await rows(c1)).length, before);
            assert.equal((await rows(c4)).length, 1, `${bad}: nothing written`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
