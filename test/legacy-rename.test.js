'use strict';

/*
 * Tests the rename one-off of lib/schema.js (renameLegacyObjects): a DB created under an
 * earlier prefix (here `old`) gets every table, index, sequence, constraint, user id
 * column and the calculator_heartbeats row under the `prv` form, once.
 *
 * Harness as in test/review-export.test.js: a dedicated DB (`${DB_NAME}_unit_legacy_rename`),
 * raw DDL, dropped on teardown. Runs under `make test-e2e`; standalone:
 *   DB_HOST=… DB_USER=… DB_PASSWORD=… DB_NAME=… node --test test/legacy-rename.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { Sequelize } = require('sequelize');
const { renameLegacyObjects } = require('../lib/schema');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const BASE_DB = process.env.DB_NAME;
const TEST_DB = `${BASE_DB}_unit_legacy_rename`;

let sequelize;

function adminClient(dbName = 'postgres') {
    return new Client({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: dbName });
}

async function q(sql, bind = []) {
    const [rows] = await sequelize.query(sql, { bind });
    return rows;
}

// Every name of schema public as `kind:name`, sorted: tables, indexes, sequences, constraints, columns.
async function catalog() {
    const rows = await q(`
        SELECT c.relkind::text || ':' || c.relname AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'i', 'S')
        UNION ALL
        SELECT 'con:' || rel.relname || '.' || con.conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace ns ON ns.oid = rel.relnamespace WHERE ns.nspname = 'public' AND con.contype IN ('p', 'f', 'u')
        UNION ALL
        SELECT 'col:' || table_name || '.' || column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name LIKE '%user_id'`);
    return rows.map((r) => r.n).sort();
}

async function logged(fn) {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.log = orig; }
    return lines;
}

before(async () => {
    assert.ok(DB_USER && BASE_DB, 'DB_USER / DB_NAME must be set (run via make test-e2e)');
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.query(`CREATE DATABASE "${TEST_DB}"`);
    await c.end();
    sequelize = new Sequelize(TEST_DB, DB_USER, DB_PASSWORD, { host: DB_HOST, port: DB_PORT, dialect: 'postgres', logging: false });
    await q(`
        CREATE TABLE old_videos (id SERIAL PRIMARY KEY, native_id TEXT);
        CREATE TABLE old_markups (id SERIAL PRIMARY KEY, video_id INTEGER REFERENCES old_videos (id),
                                  old_user_id INTEGER, deleted_by_old_user_id INTEGER);
        CREATE INDEX old_markups_video_id ON old_markups (video_id);
        CREATE TABLE users_like (id SERIAL PRIMARY KEY, generated_user_id TEXT, old_user_id INTEGER);
        CREATE UNIQUE INDEX users_generated_user_id_old_user_id ON users_like (generated_user_id, old_user_id);
        CREATE TABLE calculator_heartbeats (provider TEXT PRIMARY KEY, last_run_at TIMESTAMP NOT NULL);
        INSERT INTO calculator_heartbeats VALUES ('old', NOW()), ('rt', NOW());
        INSERT INTO old_videos (native_id) VALUES ('-1_2');
        INSERT INTO old_markups (video_id, old_user_id) VALUES (1, 7);`);
});

after(async () => {
    if (sequelize) await sequelize.close();
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.end();
});

test('legacy rename: every old_* object, the inner _old_user_id index and the user id columns take the prv form; the heartbeat row follows; a second run finds nothing', async () => {
    assert.deepEqual(await catalog(), [
        'S:old_markups_id_seq', 'S:old_videos_id_seq', 'S:users_like_id_seq',
        'col:old_markups.deleted_by_old_user_id', 'col:old_markups.old_user_id', 'col:users_like.generated_user_id',
        'col:users_like.old_user_id',
        'con:calculator_heartbeats.calculator_heartbeats_pkey', 'con:old_markups.old_markups_pkey', 'con:old_markups.old_markups_video_id_fkey', 'con:old_videos.old_videos_pkey',
        'con:users_like.users_like_pkey',
        'i:calculator_heartbeats_pkey', 'i:old_markups_pkey', 'i:old_markups_video_id', 'i:old_videos_pkey',
        'i:users_generated_user_id_old_user_id', 'i:users_like_pkey',
        'r:calculator_heartbeats', 'r:old_markups', 'r:old_videos', 'r:users_like',
    ]);

    const lines = await logged(() => renameLegacyObjects(sequelize, 'old'));
    // 3 constraints (the PK indexes follow them) + 6 relations (2 tables, 2 indexes, 2 sequences) + 3 columns + 1 heartbeat row.
    assert.deepEqual(lines, ['Legacy rename: 13 objects']);
    const renamed = [
        'S:prv_markups_id_seq', 'S:prv_videos_id_seq', 'S:users_like_id_seq',
        'col:prv_markups.deleted_by_prv_user_id', 'col:prv_markups.prv_user_id', 'col:users_like.generated_user_id',
        'col:users_like.prv_user_id',
        'con:calculator_heartbeats.calculator_heartbeats_pkey', 'con:prv_markups.prv_markups_pkey', 'con:prv_markups.prv_markups_video_id_fkey', 'con:prv_videos.prv_videos_pkey',
        'con:users_like.users_like_pkey',
        'i:calculator_heartbeats_pkey', 'i:prv_markups_pkey', 'i:prv_markups_video_id', 'i:prv_videos_pkey',
        'i:users_generated_user_id_prv_user_id', 'i:users_like_pkey',
        'r:calculator_heartbeats', 'r:prv_markups', 'r:prv_videos', 'r:users_like',
    ];
    assert.deepEqual(await catalog(), renamed);
    assert.deepEqual((await q(`SELECT provider FROM calculator_heartbeats ORDER BY provider`)).map((r) => r.provider), ['prv', 'rt']);
    // The row type follows the table; the serial default and the FK still work.
    assert.equal((await q(`SELECT typname FROM pg_type WHERE typname IN ('old_videos', 'prv_videos')`))[0].typname, 'prv_videos');
    await q(`INSERT INTO prv_markups (video_id, prv_user_id, deleted_by_prv_user_id) VALUES (1, 8, 9)`);
    await assert.rejects(q(`INSERT INTO prv_markups (video_id) VALUES (99)`), /prv_markups_video_id_fkey/);
    assert.deepEqual(await q(`SELECT id, prv_user_id FROM prv_markups ORDER BY id`), [{ id: 1, prv_user_id: 7 }, { id: 2, prv_user_id: 8 }]);

    assert.deepEqual(await logged(() => renameLegacyObjects(sequelize, 'old')), []);
    assert.deepEqual(await catalog(), renamed);
});
