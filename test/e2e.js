'use strict';

// Run: docker-compose -f docker-compose.e2e.yml up --build --abort-on-container-exit

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execSync, spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { Sequelize } = require('sequelize');
const definePrvModels = require('../prv/db');
const createReviewRepository = require('../prv/repository/review');
const { COOKIE: LANG_COOKIE, translator } = require('../lib/i18n');
const { ReviewInputError, ReviewConflictError } = createReviewRepository;

// ── Config ────────────────────────────────────────────────────────────────────

const E2E_PORT = 3099;
const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const BASE_DB = process.env.DB_NAME;
const TEST_DB = `${BASE_DB}_e2e`;
const APP_DIR = process.env.APP_DIR || '/app';

// ── State ─────────────────────────────────────────────────────────────────────

let serverProc;
let cats = {}; // { prv: { intro, sponsor }, rt: { intro, sponsor }, yt: { intro } }

// ── Setup / Teardown ──────────────────────────────────────────────────────────

before(async () => {
    await createDb();
    startServer();
    await waitForSchema();
    await waitForListen();
    cats.prv = await loadCats('');
    cats.rt = await loadCats('rt_');
    cats.yt = await loadCats('yt_');
});

after(async () => {
    stopServer();
    await dropDb();
});

// ── DB helpers ────────────────────────────────────────────────────────────────

function adminClient(dbName = 'postgres') {
    return new Client({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: dbName });
}

async function createDb() {
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.query(`CREATE DATABASE "${TEST_DB}"`);
    await c.end();
}

async function dropDb() {
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.end();
}

async function loadCats(prefix) {
    const c = adminClient(TEST_DB);
    await c.connect();
    const { rows } = await c.query(`SELECT id, category FROM ${prefix}markup_categories`);
    await c.end();
    return Object.fromEntries(rows.map(r => [r.category, r.id]));
}

// ── Server helpers ────────────────────────────────────────────────────────────

function startServer() {
    serverProc = spawn('node', ['server.js'], {
        cwd: APP_DIR,
        env: {
            ...process.env,
            DB_NAME: TEST_DB,
            NODE_APP_PORT: String(E2E_PORT),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
    serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
}

function stopServer() {
    if (serverProc) serverProc.kill();
}

async function waitForSchema() {
    // Poll until Sequelize sync() has created and seeded markup_categories
    const c = adminClient(TEST_DB);
    await c.connect();
    for (let i = 0; i < 60; i++) {
        try {
            const { rows } = await c.query(`SELECT COUNT(*) FROM markup_categories`);
            if (parseInt(rows[0].count) > 0) break;
        } catch (_) {}
        await sleep(500);
    }
    await c.end();
}

// server.js calls listen() only after bootstrap() resolves, so the schema poll
// above can succeed while port 3099 is still closed (ECONNREFUSED on a loaded
// machine). Poll the health check until it answers.
async function waitForListen() {
    for (let i = 0; i < 60; i++) {
        try {
            await request('GET', '/');
            return;
        } catch (_) {}
        await sleep(500);
    }
    throw new Error(`server did not listen on ${E2E_PORT} within 30 s`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// A string body is sent as is (pass its Content-Type in `headers`).
function request(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const req = http.request(
            {
                hostname: 'localhost',
                port: E2E_PORT,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(data && { 'Content-Length': Buffer.byteLength(data) }),
                    ...headers,
                },
            },
            res => {
                let buf = '';
                res.on('data', c => (buf += c));
                res.on('end', () => {
                    let body = null;
                    try { body = JSON.parse(buf); } catch (_) { body = buf; }
                    resolve({ status: res.statusCode, headers: res.headers, body });
                });
            }
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function postMarkup(prefix, body) {
    const path = prefix ? `/${prefix}/markup` : '/markup';
    const res = await request('POST', path, body);
    assert.equal(res.status, 201, `POST ${path} failed: ${JSON.stringify(res.body)}`);
}

async function postVote(prefix, body) {
    const path = prefix ? `/${prefix}/vote` : '/vote';
    const res = await request('POST', path, body);
    assert.equal(res.status, 204, `POST ${path} failed: ${res.status} ${JSON.stringify(res.body)}`);
}

async function getCalculated(prefix, videoId, extra = {}) {
    const params = new URLSearchParams({ video_id: videoId, ...extra });
    const path = prefix ? `/${prefix}/video-calculated?${params}` : `/video-calculated?${params}`;
    const res = await request('GET', path, null);
    return res; // { status, body: segment[] | null }
}

async function getSegmentRow(prefix, videoNativeId, catId, start, end) {
    const tp = prefix ? `${prefix}_` : '';
    const provider = prefix || 'prv';
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT s.rating FROM ${provider}_calculated_segments s
             JOIN ${tp}videos v ON v.id = s.video_id
             WHERE v.native_id = $1 AND s.category_id = $2 AND s.start = $3 AND s."end" = $4`,
            [videoNativeId, catId, start, end]
        );
        return rows[0] || null;
    } finally {
        await c.end();
    }
}

async function getJsonRating(prefix, videoNativeId, catId, start, end) {
    const tp = prefix ? `${prefix}_` : '';
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT vc.data FROM ${tp}video_calculateds vc
             JOIN ${tp}videos v ON v.id = vc.video_id
             WHERE v.native_id = $1`,
            [videoNativeId]
        );
        if (!rows[0]) return null;
        const item = rows[0].data.find(it => it.category_id === catId && it.start === start && it.end === end);
        return item ? (item.rating ?? 0) : null;
    } finally {
        await c.end();
    }
}

async function countVideos(prefix, nativeId) {
    const tp = prefix ? `${prefix}_` : '';
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(`SELECT COUNT(*) FROM ${tp}videos WHERE native_id = $1`, [nativeId]);
        return parseInt(rows[0].count);
    } finally {
        await c.end();
    }
}

// ── Calculator helper ─────────────────────────────────────────────────────────

function runCalc(provider) {
    const bin = `${APP_DIR}/${provider}/commands/calculate`;
    execSync(bin, { env: { ...process.env, DB_NAME: TEST_DB } });
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

function findSeg(segs, catId, start, end) {
    return (segs || []).find(s => s.category_id === catId && s.start === start && s.end === end);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Metrics helpers ───────────────────────────────────────────────────────────

async function fetchMetrics() {
    const res = await request('GET', '/metrics', null);
    assert.equal(res.status, 200, `/metrics returned ${res.status}`);
    return typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
}

function parseCounter(text, name, labels) {
    const labelEntries = Object.entries(labels);
    const labelRegex = labelEntries
        .map(([k, v]) => `${k}="${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
        .join(',[^}]*');
    const re = new RegExp(`^${name}\\{[^}]*${labelRegex}[^}]*\\}\\s+([0-9.eE+\\-]+)`, 'm');
    const match = text.match(re);
    return match ? Number(match[1]) : 0;
}

async function getLookupCount(outcome, provider) {
    const text = await fetchMetrics();
    return parseCounter(text, 'video_calculated_lookup_total', { outcome, provider });
}

async function getRequestWithoutVersionCount(method, provider) {
    const text = await fetchMetrics();
    return parseCounter(text, 'request_without_version_total', { method, provider });
}

function httpDurationHasPath(text, pathValue) {
    const escaped = pathValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^http_request_duration_seconds_(bucket|count|sum)\\{[^}]*path="${escaped}"`, 'm');
    return re.test(text);
}

// ── prv Tests ──────────────────────────────────────────────────────────────────

// starts=[0,1,2] all bucket 0 → startAvg=1, ends=[10,12,11] median=11
test('prv: basic median', async () => {
    const vid = '__e2e__prv_basic';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.ok(findSeg(body, cats.prv.intro, 1, 11), `expected {start:1 end:11}, got ${JSON.stringify(body)}`);
});

// ends=[10,12,100] → median picks 12, ignores outlier 100
test('prv: outlier end ignored by median', async () => {
    const vid = '__e2e__prv_outlier';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 100 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.ok(findSeg(body, cats.prv.intro, 1, 12), `expected end=12, got ${JSON.stringify(body)}`);
});

// 2 markups: median picks upper value (index l/2=1) — documents this edge case
test('prv: two markups — upper median behavior', async () => {
    const vid = '__e2e__prv_upper_median';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 500 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    // FindMedian([10,500])[1] = 500 — upper value picked with even count
    assert.ok(findSeg(body, cats.prv.intro, 0, 500), `expected end=500 (upper median), got ${JSON.stringify(body)}`);
});

// Bucket 0: starts=[0,2] avg=1 ends=[10,11] median=11
// Bucket 3: starts=[3,5] avg=4 ends=[20,22] median=22
test('prv: two 3-second buckets', async () => {
    const vid = '__e2e__prv_two_buckets';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 3, end: 20 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 5, end: 22 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.equal(body.length, 2, `expected 2 segments, got ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.prv.intro, 1, 11), `bucket 0 missing: ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.prv.intro, 4, 22), `bucket 3 missing: ${JSON.stringify(body)}`);
});

// Buckets at 0s, 3s, 6s
test('prv: three 3-second buckets (0, 3, 6)', async () => {
    const vid = '__e2e__prv_three_buckets';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 3, end: 20 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 4, end: 21 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 6, end: 30 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 8, end: 32 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.equal(body.length, 3, `expected 3 segments, got ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.prv.intro, 1, 11), `bucket 0 missing`);
    assert.ok(findSeg(body, cats.prv.intro, 3, 21), `bucket 3 missing`);
    assert.ok(findSeg(body, cats.prv.intro, 7, 32), `bucket 6 missing`);
});

// start=2 → bucket 0, start=3 → bucket 3, must NOT be merged
test('prv: bucket boundary — start 2 vs start 3', async () => {
    const vid = '__e2e__prv_boundary';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 3, end: 20 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.equal(body.length, 2, `start=2 and start=3 must be in different buckets, got ${JSON.stringify(body)}`);
});

// intro at bucket 0, sponsor at bucket 30 → 2 independent segments
test('prv: different categories on same video', async () => {
    const vid = '__e2e__prv_categories';
    const base = { video_id: vid, v: '1', user_id: 'test-user', data: {} };
    await postMarkup('', { ...base, category_id: cats.prv.intro,   data: { intervals: [{ start: 0,  end: 10 }] } });
    await postMarkup('', { ...base, category_id: cats.prv.intro,   data: { intervals: [{ start: 1,  end: 11 }] } });
    await postMarkup('', { ...base, category_id: cats.prv.sponsor, data: { intervals: [{ start: 30, end: 50 }] } });
    await postMarkup('', { ...base, category_id: cats.prv.sponsor, data: { intervals: [{ start: 31, end: 51 }] } });

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.equal(body.length, 2, `expected 2 segments (intro + sponsor), got ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.prv.intro,   0,  11), `intro segment missing`);
    assert.ok(findSeg(body, cats.prv.sponsor, 30, 51), `sponsor segment missing`);
});

// 5 markups: ends=[1,3,5,7,100] sorted → index 2 = 5 (true middle)
test('prv: five markups — true middle median', async () => {
    const vid = '__e2e__prv_five';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro, data: {} };
    for (const end of [1, 3, 5, 7, 100]) {
        await postMarkup('', { ...base, data: { intervals: [{ start: 0, end }] } });
    }

    runCalc('prv');

    const { status, body } = await getCalculated('', vid, { v: '1' });
    assert.equal(status, 200);
    assert.ok(findSeg(body, cats.prv.intro, 0, 5), `expected end=5 (true middle of 5 values), got ${JSON.stringify(body)}`);
});

// ── RT Tests ──────────────────────────────────────────────────────────────────

// RT: duration is required, no v param, endpoints at /rt/*
test('RT: basic median with required duration', async () => {
    const vid = '__e2e__rt_basic';
    const base = { video_id: vid, user_id: 'test-user', category_id: cats.rt.intro, duration: 300, data: {} };
    await postMarkup('rt', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('rt', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('rt', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });

    runCalc('rt');

    const { status, body } = await getCalculated('rt', vid, { duration: 300 });
    assert.equal(status, 200);
    assert.ok(findSeg(body, cats.rt.intro, 1, 11), `expected {start:1 end:11}, got ${JSON.stringify(body)}`);
});

// RT: two buckets + two categories
test('RT: two buckets and two categories', async () => {
    const vid = '__e2e__rt_full';
    const base = { video_id: vid, user_id: 'test-user', duration: 300, data: {} };
    // intro bucket 0: avg=1, median=11
    await postMarkup('rt', { ...base, category_id: cats.rt.intro,   data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('rt', { ...base, category_id: cats.rt.intro,   data: { intervals: [{ start: 2, end: 11 }] } });
    // sponsor bucket 6: avg=6, median=42
    await postMarkup('rt', { ...base, category_id: cats.rt.sponsor, data: { intervals: [{ start: 6, end: 40 }] } });
    await postMarkup('rt', { ...base, category_id: cats.rt.sponsor, data: { intervals: [{ start: 7, end: 42 }] } });

    runCalc('rt');

    const { status, body } = await getCalculated('rt', vid, { duration: 300 });
    assert.equal(status, 200);
    assert.equal(body.length, 2, `expected 2 segments, got ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.rt.intro,   1, 11), `RT intro missing`);
    assert.ok(findSeg(body, cats.rt.sponsor, 6, 42), `RT sponsor missing`);
});

// ── YT Tests ─────────────────────────────────────────────────────────────────

// YT: outlier end + three different buckets
test('YT: outlier end and three buckets', async () => {
    const vid = '__e2e__yt_full';
    const base = { video_id: vid, user_id: 'test-user', category_id: cats.yt.intro, duration: 600, data: {} };
    // Bucket 0: ends=[5,6,999] sorted→[5,6,999][1]=6
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 0, end: 5   }] } });
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 1, end: 999 }] } });
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 2, end: 6   }] } });
    // Bucket 3 (start=4): single markup → start=4, end=20
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 4, end: 20  }] } });
    // Bucket 9: starts=[9,11] avg=10, ends=[30,31] median=31
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 9,  end: 30 }] } });
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 11, end: 31 }] } });

    runCalc('yt');

    const { status, body } = await getCalculated('yt', vid, { duration: 600 });
    assert.equal(status, 200);
    assert.equal(body.length, 3, `expected 3 segments, got ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.yt.intro, 1,  6),  `bucket 0 (outlier excluded) missing`);
    assert.ok(findSeg(body, cats.yt.intro, 4,  20), `bucket 3 single markup missing`);
    assert.ok(findSeg(body, cats.yt.intro, 10, 31), `bucket 9 missing`);
});

// ── Calculator robustness (one transaction per video, is_new by read ids) ─────

async function dbQuery(sql, params = []) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        return (await c.query(sql, params)).rows;
    } finally {
        await c.end();
    }
}

async function prvVideoId(nativeId) {
    const rows = await dbQuery(`SELECT id FROM videos WHERE native_id = $1`, [nativeId]);
    return rows[0].id;
}

async function prvSegmentRows(videoId) {
    return dbQuery(
        `SELECT s.category_id, s.start, s."end", COUNT(sm.id)::int AS markups
         FROM prv_calculated_segments s
         LEFT JOIN prv_calculated_segment_markups sm ON sm.segment_id = s.id
         WHERE s.video_id = $1 GROUP BY s.id ORDER BY s.start`,
        [videoId]
    );
}

async function isNewFlags(nativeId) {
    return (await getMarkupsByVideoNative(nativeId)).map(m => m.is_new);
}

// Like runCalc, but returns the exit status and output instead of throwing; the
// timeout turns a calculator stuck on a lock into a failed assertion, not a hang.
function runCalcStatus(provider) {
    return spawnSync(`${APP_DIR}/${provider}/commands/calculate`, [], {
        env: { ...process.env, DB_NAME: TEST_DB }, encoding: 'utf8', timeout: 15000,
    });
}

function runCalcAsync(provider) {
    return new Promise((resolve, reject) => {
        const proc = spawn(`${APP_DIR}/${provider}/commands/calculate`, [], {
            env: { ...process.env, DB_NAME: TEST_DB },
        });
        let output = '';
        proc.stdout.on('data', d => (output += d));
        proc.stderr.on('data', d => (output += d));
        proc.on('error', reject);
        proc.on('close', status => resolve({ status, output }));
    });
}

async function waitForQueryBlockedOnLock(fragment) {
    for (let i = 0; i < 200; i++) {
        const rows = await dbQuery(
            `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query LIKE $2`,
            [TEST_DB, `%${fragment}%`]
        );
        if (rows.length) return;
        await sleep(50);
    }
    throw new Error(`no query blocked on a lock matching "${fragment}"`);
}

async function heartbeat(provider) {
    const rows = await dbQuery(
        `SELECT last_run_at, last_success_at, failed_videos FROM calculator_heartbeats WHERE provider = $1`,
        [provider]);
    return rows[0] || null;
}

// Every run (also an idle one) ends with a heartbeat row; GET /metrics turns it
// into the gauges the Grafana alert watches. A missing table (Go cron before
// Node's first sync on a fresh deploy) is a logged failure, not a panic.
test('calculator: a run writes the heartbeat and /metrics exposes it', async () => {
    await dbQuery(`DELETE FROM calculator_heartbeats WHERE provider = 'prv'`);
    const before = Date.now() - 1000;
    runCalc('prv');
    const hb = await heartbeat('prv');
    assert.ok(hb, 'heartbeat row for prv');
    assert.equal(hb.failed_videos, 0);
    assert.ok(hb.last_run_at.getTime() >= before, `last_run_at ${hb.last_run_at}`);
    assert.equal(hb.last_success_at.getTime(), hb.last_run_at.getTime());

    const text = await fetchMetrics();
    const successTs = parseCounter(text, 'calculator_last_success_timestamp_seconds', { provider: 'prv' });
    assert.equal(Math.round(successTs), Math.round(hb.last_success_at.getTime() / 1000));
    assert.equal(parseCounter(text, 'calculator_last_run_timestamp_seconds', { provider: 'prv' }), successTs);
    // parseCounter reads a missing series as 0, so a clean run needs the line itself.
    assert.match(text, /^calculator_failed_videos\{provider="prv"\} 0$/m, 'calculator_failed_videos is exposed as 0');

    await dbQuery(`ALTER TABLE calculator_heartbeats RENAME TO calculator_heartbeats_e2e_gone`);
    let r;
    try {
        r = runCalcStatus('prv');
    } finally {
        await dbQuery(`ALTER TABLE calculator_heartbeats_e2e_gone RENAME TO calculator_heartbeats`);
    }
    assert.equal(r.status, 1, `calculator should exit 1 without the table, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Heartbeat write failed: .*calculator_heartbeats/);
});

// A failure after the clear (a trigger rejects A's segment insert) rolls A back
// to its previous segments; B, in the same run, is still calculated, and the
// binary exits non-zero.
test('calculator: a failing video keeps its previous segments, the others are still calculated', async () => {
    const vidA = '__e2e__prv_calc_fail_a';
    const vidB = '__e2e__prv_calc_fail_b';
    const base = { v: '1', user_id: 'test-user', category_id: cats.prv.intro };
    await postMarkup('', { ...base, video_id: vidA, data: { intervals: [{ start: 0, end: 10 }] } });
    runCalc('prv');
    const idA = await prvVideoId(vidA);

    await postMarkup('', { ...base, video_id: vidA, data: { intervals: [{ start: 30, end: 40 }] } });
    await postMarkup('', { ...base, video_id: vidB, data: { intervals: [{ start: 0, end: 20 }] } });

    await dbQuery(`CREATE FUNCTION e2e_reject_segment() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF NEW.video_id = ${idA} THEN RAISE EXCEPTION 'e2e: segment insert rejected'; END IF;
            RETURN NEW;
        END $$`);
    let r;
    try {
        await dbQuery(`CREATE TRIGGER e2e_reject_segment BEFORE INSERT ON prv_calculated_segments
            FOR EACH ROW EXECUTE FUNCTION e2e_reject_segment()`);
        r = runCalcStatus('prv');
    } finally {
        await dbQuery(`DROP TRIGGER IF EXISTS e2e_reject_segment ON prv_calculated_segments`);
        await dbQuery(`DROP FUNCTION e2e_reject_segment()`);
    }

    assert.equal(r.status, 1, `calculator should exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`Calculate video failed: ${idA}: .*e2e: segment insert rejected`));
    assert.match(r.stderr, /1 of \d+ videos failed/);

    const hb = await heartbeat('prv');
    assert.equal(hb.failed_videos, 1, 'heartbeat counts the failed video');
    assert.ok(hb.last_success_at < hb.last_run_at, `last_success_at must stay at the previous run: ${JSON.stringify(hb)}`);
    assert.equal(parseCounter(await fetchMetrics(), 'calculator_failed_videos', { provider: 'prv' }), 1,
        'calculator_failed_videos gauge follows the heartbeat');

    const a = await getCalculated('', vidA, { v: '1' });
    assert.equal(a.status, 200);
    assert.equal(a.body.length, 1, `A must keep its previous data, got ${JSON.stringify(a.body)}`);
    assert.ok(findSeg(a.body, cats.prv.intro, 0, 10));
    assert.deepEqual(await prvSegmentRows(idA), [{ category_id: cats.prv.intro, start: 0, end: 10, markups: 1 }]);
    assert.deepEqual(await isNewFlags(vidA), [false, true], 'A\'s new markup must stay is_new');

    const b = await getCalculated('', vidB, { v: '1' });
    assert.equal(b.status, 200);
    assert.ok(findSeg(b.body, cats.prv.intro, 0, 20), `B must be calculated, got ${JSON.stringify(b.body)}`);
    assert.deepEqual(await isNewFlags(vidB), [false]);

    runCalc('prv');
    const a2 = await getCalculated('', vidA, { v: '1' });
    assert.equal(a2.body.length, 2, `next run must pick A up, got ${JSON.stringify(a2.body)}`);
    assert.deepEqual(await isNewFlags(vidA), [false, false]);
});

// The run is held at the video_calculateds row lock (taken before the segments
// are cleared), after it has read the markups; a markup posted meanwhile is neither aggregated nor marked
// processed, so the next run picks it up.
test('calculator: a markup posted during the recalculation stays is_new for the next run', async () => {
    const vid = '__e2e__prv_calc_concurrent';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    runCalc('prv');
    await postMarkup('', { ...base, data: { intervals: [{ start: 30, end: 40 }] } });
    const videoId = await prvVideoId(vid);

    const lock = adminClient(TEST_DB);
    await lock.connect();
    let calc;
    let result;
    try {
        await lock.query('BEGIN');
        await lock.query('SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE', [videoId]);
        calc = runCalcAsync('prv');
        await waitForQueryBlockedOnLock('FROM video_calculateds WHERE video_id = $1 FOR UPDATE');
        await postMarkup('', { ...base, data: { intervals: [{ start: 60, end: 70 }] } });
    } finally {
        await lock.query('COMMIT');
        await lock.end();
        if (calc) result = await calc;
    }

    assert.equal(result.status, 0, result.output);
    const { body } = await getCalculated('', vid, { v: '1' });
    assert.equal(body.length, 2, `the markup posted mid-run must not be aggregated yet, got ${JSON.stringify(body)}`);
    assert.ok(findSeg(body, cats.prv.intro, 0, 10));
    assert.ok(findSeg(body, cats.prv.intro, 30, 40));
    assert.deepEqual(await isNewFlags(vid), [false, false, true]);

    runCalc('prv');
    const next = await getCalculated('', vid, { v: '1' });
    assert.ok(findSeg(next.body, cats.prv.intro, 60, 70), `next run must aggregate it, got ${JSON.stringify(next.body)}`);
    assert.deepEqual(await isNewFlags(vid), [false, false, false]);
});

// A markup row another transaction holds (an API write in flight) is not waited
// for: its intervals are aggregated, but it stays is_new for the next run.
test('calculator: a markup locked by another transaction is not waited for and stays is_new', async () => {
    const vid = '__e2e__prv_calc_locked';
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cats.prv.intro };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    const [markup] = await getMarkupsByVideoNative(vid);

    const lock = adminClient(TEST_DB);
    await lock.connect();
    let r;
    try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM markups WHERE id = $1 FOR UPDATE', [markup.id]);
        r = runCalcStatus('prv');
    } finally {
        await lock.query('ROLLBACK');
        await lock.end();
    }

    assert.equal(r.status, 0, `calculator must not block on the lock: ${r.error || ''} ${r.stdout}${r.stderr}`);
    const { body } = await getCalculated('', vid, { v: '1' });
    assert.ok(findSeg(body, cats.prv.intro, 0, 10), `got ${JSON.stringify(body)}`);
    assert.deepEqual(await isNewFlags(vid), [true]);

    runCalc('prv');
    assert.deepEqual(await isNewFlags(vid), [false]);
});

// ── Calculator: segment ratings come from the votes table ─────────────────────

function runRecomputeRatings(provider) {
    const r = spawnSync(`${APP_DIR}/${provider}/commands/calculate`, ['--recompute-ratings'], {
        env: { ...process.env, DB_NAME: TEST_DB }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, `--recompute-ratings failed: ${r.error || ''} ${r.stdout}${r.stderr}`);
    const m = r.stdout.match(/Recompute ratings finish: (\d+) videos processed, (\d+) segments changed, (\d+) video_calculateds rewritten/);
    assert.ok(m, `no summary line in: ${r.stdout}`);
    return { videos: Number(m[1]), segments: Number(m[2]), rewritten: Number(m[3]) };
}

// Video with one intro segment {start:1, end:11} (bucket 0: starts 0,1,2; ends 10,12,11).
async function seedRatedVideo(prefix, vid, cat, extra = {}) {
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cat, ...extra };
    await postMarkup(prefix, { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup(prefix, { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup(prefix, { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc(prefix || 'prv');
}

async function assertVoteSurvivesRecalc(prefix) {
    const provider = prefix || 'prv';
    const vid = `__e2e__${provider}_vote_survives_recalc`;
    const duration = 300;
    const extra = prefix ? { duration } : {};
    const voterExtra = prefix ? { prv_user_id: 1, duration } : {};
    await seedRatedVideo(prefix, vid, cats[provider].intro, extra);
    await postVote(prefix, {
        video_id: vid, user_id: 'voter-1', category_id: cats[provider].intro, start: 1, end: 11, vote: 1, ...voterExtra,
    });

    // A markup in another category and bucket makes the next run recalculate the video.
    await postMarkup(prefix, {
        video_id: vid, v: '1', user_id: 'test-user', category_id: cats[provider].sponsor, ...extra,
        data: { intervals: [{ start: 60, end: 70 }] },
    });
    runCalc(provider);

    assert.equal(await getJsonRating(prefix, vid, cats[provider].sponsor, 60, 70), 0, 'the new segment is calculated');
    assert.equal((await getSegmentRow(prefix, vid, cats[provider].intro, 1, 11)).rating, 1, 'segment table rating');
    assert.equal(await getJsonRating(prefix, vid, cats[provider].intro, 1, 11), 1, 'JSON rating');
}

test('calculator: a vote survives a recalculation of the video (prv)', async () => {
    await assertVoteSurvivesRecalc('');
});

test('calculator: a vote survives a recalculation of the video (rt, yt)', async () => {
    await assertVoteSurvivesRecalc('rt');
    await assertVoteSurvivesRecalc('yt');
});

// Two vote rows of one user (pre-May data): only the newer one counts.
test('calculator: only each user\'s latest vote counts', async () => {
    const vid = '__e2e__prv_calc_latest_vote';
    const cat = cats.prv.intro;
    await seedRatedVideo('', vid, cat);
    const videoId = await prvVideoId(vid);
    await dbQuery(
        `INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt") VALUES
         ('dup-voter', $1, $2, 1, 11, -1, now() - interval '1 day', now() - interval '1 day'),
         ('dup-voter', $1, $2, 1, 11,  1, now(), now()),
         ('other-voter', $1, $2, 1, 12, -1, now(), now())`,
        [videoId, cat]
    );

    runCalc('prv'); // no new markups: nothing recalculated
    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 0);

    execSync(`${APP_DIR}/prv/commands/calculate ${videoId}`, { env: { ...process.env, DB_NAME: TEST_DB } });

    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 1, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), 1, 'JSON rating');
});

test('calculator: --recompute-ratings restores ratings from votes and leaves segments and is_new alone', async () => {
    const vid = '__e2e__prv_recompute_ratings';
    const cat = cats.prv.intro;
    await seedRatedVideo('', vid, cat);
    await postVote('', { video_id: vid, user_id: 'voter-1', category_id: cat, start: 1, end: 11, vote: 1 });
    await postVote('', { video_id: vid, user_id: 'voter-2', category_id: cat, start: 1, end: 11, vote: 1 });
    const videoId = await prvVideoId(vid);

    // Lose the rating the way an old recalculation did; a pending markup must stay pending.
    await dbQuery(`UPDATE prv_calculated_segments SET rating = 0 WHERE video_id = $1`, [videoId]);
    const [{ data }] = await dbQuery(`SELECT data FROM video_calculateds WHERE video_id = $1`, [videoId]);
    const stripped = data.map(({ rating: _, ...rest }) => rest);
    await dbQuery(`UPDATE video_calculateds SET data = $1 WHERE video_id = $2`, [JSON.stringify(stripped), videoId]);
    await postMarkup('', {
        video_id: vid, v: '1', user_id: 'test-user', category_id: cat, data: { intervals: [{ start: 30, end: 40 }] },
    });
    const segmentsBefore = await prvSegmentRows(videoId);
    const flagsBefore = await isNewFlags(vid);

    const first = runRecomputeRatings('prv');
    assert.ok(first.segments >= 1 && first.rewritten >= 1, `first run must change the rating: ${JSON.stringify(first)}`);
    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 2, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), 2, 'JSON rating');
    assert.deepEqual(await prvSegmentRows(videoId), segmentsBefore, 'segment boundaries unchanged');
    assert.deepEqual(await isNewFlags(vid), flagsBefore, 'is_new unchanged');
    assert.deepEqual(flagsBefore, [false, false, false, true]);
    const [{ data: after }] = await dbQuery(`SELECT data FROM video_calculateds WHERE video_id = $1`, [videoId]);
    assert.deepEqual(after.map(({ rating: _, ...rest }) => rest), stripped, 'entry order and other fields kept');

    const second = runRecomputeRatings('prv');
    assert.equal(second.segments, 0, 'a second run changes no segment');
    assert.equal(second.rewritten, 0, 'a second run rewrites no JSON');
    assert.ok(second.videos >= 1);
});

// ── Video lookup tests (no orphan Video rows) ─────────────────────────────────

// GET must not create a Video row when the video doesn't exist
test('prv GET /video-calculated: unknown video returns 204 and creates no Video row', async () => {
    const vid = '__e2e__prv_no_orphan';
    const res = await getCalculated('', vid, { v: '1' });
    assert.equal(res.status, 204);
    assert.equal(await countVideos('', vid), 0, 'no Video row should be created');
});

// Rule 1: find by native_id + duration within ±2
test('prv GET /video-calculated: finds video by duration within ±2', async () => {
    const vid = '__e2e__prv_duration_range';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');
    const res = await getCalculated('', vid, { v: '1', duration: 302 });
    assert.equal(res.status, 200, 'should find video with duration 300 when requesting 302');
});

// POST /markup with a duration within ±2 of an existing video must reuse it, not split off a new
// Video row; a diff of 3 must split. A duration that fits both rows of a split pair lands on the
// closest one, on the write and on the read path alike.
test('prv POST /markup: duration within ±2 reuses the video, diff of 3 splits, closest row wins', async () => {
    const vid = '__e2e__prv_split_boundary';
    const cat = cats.prv.intro;
    const markup = (user, duration, end) =>
        postMarkup('', { video_id: vid, v: '1', user_id: user, category_id: cat, duration, data: { intervals: [{ start: 0, end }] } });
    const markupVideoDurations = async () => {
        const c = adminClient(TEST_DB);
        await c.connect();
        try {
            const { rows } = await c.query(
                `SELECT m.user_id, v.duration FROM markups m JOIN videos v ON v.id = m.video_id
                 WHERE v.native_id = $1 ORDER BY m.id`, [vid]);
            return Object.fromEntries(rows.map(r => [r.user_id.trim(), r.duration]));
        } finally {
            await c.end();
        }
    };

    await markup('u1', 300, 10);
    await markup('u2', 302, 10);
    assert.equal(await countVideos('', vid), 1, 'duration 302 should match the 300 row, not split');
    await markup('u3', 303, 20);
    assert.equal(await countVideos('', vid), 2, 'duration 303 should split into a new Video row');

    // 302 is within ±2 of both 300 and 303: the closest row (303) wins, deterministically.
    await markup('u4', 302, 20);
    assert.equal(await countVideos('', vid), 2, 'duration 302 should reuse a row of the pair');
    assert.deepEqual(await markupVideoDurations(), { u1: 300, u2: 300, u3: 303, u4: 303 });

    runCalc('prv');
    const res = await getCalculated('', vid, { v: '1', duration: 302 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map(s => s.end), [20], 'read with 302 serves the 303 row, same as the write');
});

// Rule 2: find by native_id with null duration, update it
test('prv GET /video-calculated: falls back to null-duration video and updates it', async () => {
    const vid = '__e2e__prv_null_duration';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');
    const res = await getCalculated('', vid, { v: '1', duration: 300 });
    assert.equal(res.status, 200, 'should find null-duration video and serve calculated data');
});

// Rule 3: find any video by native_id when duration doesn't match
test('prv GET /video-calculated: falls back to any video when duration is far off', async () => {
    const vid = '__e2e__prv_fallback_any';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 100, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');
    const res = await getCalculated('', vid, { v: '1', duration: 500 });
    assert.equal(res.status, 200, 'should fall back to any video with matching native_id');
});

// RT: GET must not create a Video row when the video doesn't exist
test('RT GET /video-calculated: unknown video returns 204 and creates no Video row', async () => {
    const vid = '__e2e__rt_no_orphan';
    const res = await getCalculated('rt', vid, { duration: 300 });
    assert.equal(res.status, 204);
    assert.equal(await countVideos('rt', vid), 0, 'no Video row should be created');
});

// ── Lookup-outcome metric tests ───────────────────────────────────────────────

test('prv lookup metric: match outcome increments on duration ±2 hit', async () => {
    const vid = '__e2e__prv_metric_match';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');

    const before = await getLookupCount('match', 'prv');
    const res = await getCalculated('', vid, { v: '1', duration: 302 });
    assert.equal(res.status, 200);
    const after = await getLookupCount('match', 'prv');
    assert.equal(after - before, 1, 'match counter should increment by 1');
});

test('prv lookup metric: backfilled outcome increments when duration was null', async () => {
    const vid = '__e2e__prv_metric_backfilled';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');

    const before = await getLookupCount('backfilled', 'prv');
    const res = await getCalculated('', vid, { v: '1', duration: 300 });
    assert.equal(res.status, 200);
    const after = await getLookupCount('backfilled', 'prv');
    assert.equal(after - before, 1, 'backfilled counter should increment by 1');
});

test('prv lookup metric: mismatch outcome increments when stored duration differs', async () => {
    const vid = '__e2e__prv_metric_mismatch';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 100, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');

    const before = await getLookupCount('mismatch', 'prv');
    const res = await getCalculated('', vid, { v: '1', duration: 500 });
    assert.equal(res.status, 200);
    const after = await getLookupCount('mismatch', 'prv');
    assert.equal(after - before, 1, 'mismatch counter should increment by 1');
});

test('prv lookup metric: no_duration outcome when request omits duration', async () => {
    const vid = '__e2e__prv_metric_no_duration';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');

    const before = await getLookupCount('no_duration', 'prv');
    const res = await getCalculated('', vid, { v: '1' });
    assert.equal(res.status, 200);
    const after = await getLookupCount('no_duration', 'prv');
    assert.equal(after - before, 1, 'no_duration counter should increment by 1');
});

test('prv lookup metric: not_calculated outcome when Video exists but VideoCalculated missing', async () => {
    const vid = '__e2e__prv_metric_not_calculated';
    const cat = cats.prv.intro;
    // Create a Video row via POST /markup (which inserts the video), but DO NOT run the calculator,
    // so VideoCalculated will be missing.
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }] } });

    const before = await getLookupCount('not_calculated', 'prv');
    const res = await getCalculated('', vid, { v: '1', duration: 300 });
    assert.equal(res.status, 204, 'should return 204 when VideoCalculated missing');
    const after = await getLookupCount('not_calculated', 'prv');
    assert.equal(after - before, 1, 'not_calculated counter should increment by 1');
});

test('prv lookup metric: not_found outcome when no Video row exists', async () => {
    const vid = '__e2e__prv_metric_not_found';

    const before = await getLookupCount('not_found', 'prv');
    const res = await getCalculated('', vid, { v: '1', duration: 300 });
    assert.equal(res.status, 204);
    const after = await getLookupCount('not_found', 'prv');
    assert.equal(after - before, 1, 'not_found counter should increment by 1');
});

test('RT lookup metric: match outcome carries provider=rt', async () => {
    const vid = '__e2e__rt_metric_match';
    const cat = cats.rt.intro;
    await postMarkup('rt', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('rt');

    const before = await getLookupCount('match', 'rt');
    const res = await getCalculated('rt', vid, { duration: 300 });
    assert.equal(res.status, 200);
    const after = await getLookupCount('match', 'rt');
    assert.equal(after - before, 1, 'match counter for rt should increment by 1');
});

test('YT lookup metric: match outcome carries provider=yt', async () => {
    const vid = '__e2e__yt_metric_match';
    const cat = cats.yt.intro;
    await postMarkup('yt', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('yt');

    const before = await getLookupCount('match', 'yt');
    const res = await getCalculated('yt', vid, { duration: 300 });
    assert.equal(res.status, 200);
    const after = await getLookupCount('match', 'yt');
    assert.equal(after - before, 1, 'match counter for yt should increment by 1');
});

test('prv request_without_version metric: increments when POST /markup omits v', async () => {
    const vid = '__e2e__prv_no_v_post_markup';
    const cat = cats.prv.intro;
    const before = await getRequestWithoutVersionCount('POST /markup', 'prv');

    // No `v` field on body — exercises the legacy branch in prv/routes/markups.js.
    await postMarkup('', { video_id: vid, user_id: 'u1', category_id: cat, data: { intervals: [{ start: 0, end: 10 }] } });

    const after = await getRequestWithoutVersionCount('POST /markup', 'prv');
    assert.equal(after - before, 1, 'request_without_version_total{method=POST /markup, provider=prv} should increment by 1');
});

// ── Vote Tests ────────────────────────────────────────────────────────────────

// Calculator emits rating=0 in both the segments table and video_calculateds.data
test('prv vote: initial rating is 0 in table and JSON', async () => {
    const vid = '__e2e__prv_vote_initial';
    const cat = cats.prv.intro;
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('prv');

    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 0, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), 0, 'JSON rating');
});

// vote=+1 → rating=1 in prv_calculated_segments and video_calculateds.data
test('prv vote: +1 increments rating in table and JSON', async () => {
    const vid = '__e2e__prv_vote_basic';
    const cat = cats.prv.intro;
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('prv');

    await postVote('', { video_id: vid, user_id: 'voter-1', category_id: cat, start: 1, end: 11, vote: 1 });

    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 1, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), 1, 'JSON rating');
});

// re-vote applies diff: +1 then -1 ⇒ diff=-2 ⇒ net rating=-1
test('prv vote: re-vote applies diff to rating', async () => {
    const vid = '__e2e__prv_vote_revote';
    const cat = cats.prv.intro;
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('prv');

    const voteBase = { video_id: vid, user_id: 'voter-1', category_id: cat, start: 1, end: 11 };
    await postVote('', { ...voteBase, vote: 1 });
    await postVote('', { ...voteBase, vote: -1 });

    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, -1, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), -1, 'JSON rating');
});

// independent users stack: +1 +1 -1 ⇒ rating=1
test('prv vote: ratings stack across users', async () => {
    const vid = '__e2e__prv_vote_multi';
    const cat = cats.prv.intro;
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('prv');

    const voteBase = { video_id: vid, category_id: cat, start: 1, end: 11 };
    await postVote('', { ...voteBase, user_id: 'voter-1', vote:  1 });
    await postVote('', { ...voteBase, user_id: 'voter-2', vote:  1 });
    await postVote('', { ...voteBase, user_id: 'voter-3', vote: -1 });

    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 1, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), 1, 'JSON rating');
});

// vote on a non-existent segment must not affect any other segment
test('prv vote: 404 for non-matching start/end leaves rating untouched', async () => {
    const vid = '__e2e__prv_vote_nomatch';
    const cat = cats.prv.intro;
    const base = { video_id: vid, v: '1', user_id: 'test-user', category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('prv');

    const res = await request('POST', '/vote', {
        video_id: vid, user_id: 'voter-1', category_id: cat, start: 99, end: 99, vote: 1,
    });
    assert.equal(res.status, 404);

    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 0, 'rating unchanged');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), 0, 'JSON rating unchanged');
});

// RT: vote requires duration and prv_user_id
test('RT vote: +1 increments rating with duration check', async () => {
    const vid = '__e2e__rt_vote';
    const cat = cats.rt.intro;
    const duration = 300;
    const base = { video_id: vid, user_id: 'test-user', category_id: cat, duration, data: {} };
    await postMarkup('rt', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('rt', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('rt', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('rt');

    await postVote('rt', {
        video_id: vid, user_id: 'voter-1', prv_user_id: 1, category_id: cat,
        start: 1, end: 11, vote: 1, duration,
    });

    assert.equal((await getSegmentRow('rt', vid, cat, 1, 11)).rating, 1, 'segment table rating');
    assert.equal(await getJsonRating('rt', vid, cat, 1, 11), 1, 'JSON rating');
});

// YT: vote requires duration and prv_user_id
test('YT vote: +1 increments rating with duration check', async () => {
    const vid = '__e2e__yt_vote';
    const cat = cats.yt.intro;
    const duration = 600;
    const base = { video_id: vid, user_id: 'test-user', category_id: cat, duration, data: {} };
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 1, end: 12 }] } });
    await postMarkup('yt', { ...base, data: { intervals: [{ start: 2, end: 11 }] } });
    runCalc('yt');

    await postVote('yt', {
        video_id: vid, user_id: 'voter-1', prv_user_id: 1, category_id: cat,
        start: 1, end: 11, vote: 1, duration,
    });

    assert.equal((await getSegmentRow('yt', vid, cat, 1, 11)).rating, 1, 'segment table rating');
    assert.equal(await getJsonRating('yt', vid, cat, 1, 11), 1, 'JSON rating');
});

// ── Vote delete (Grafana GET link) ────────────────────────────────────────────

const VOTE_AUTH = process.env.AUTH_TOKEN || 'test_token';

async function userRating(prefix, generatedUserId) {
    const tp = prefix ? `${prefix}_` : '';
    const rows = await dbQuery(`SELECT rating FROM ${tp}users WHERE generated_user_id = $1`, [generatedUserId]);
    return rows[0].rating;
}

async function voteIdOf(prefix, userId, nativeId) {
    const tp = prefix ? `${prefix}_` : '';
    const rows = await dbQuery(
        `SELECT vt.id FROM ${tp}votes vt JOIN ${tp}videos v ON v.id = vt.video_id
         WHERE vt.user_id = $1 AND v.native_id = $2`,
        [userId, nativeId]
    );
    assert.equal(rows.length, 1, `expected one vote of ${userId}`);
    return rows[0].id;
}

// The delete undoes what POST /vote did: segment rating (table + JSON) and the
// author's rating change. The voter is a user too (they posted a markup), and
// their own rating is not touched.
async function assertVoteDeleteUndoesVote(prefix) {
    const provider = prefix || 'prv';
    const cat = cats[provider].intro;
    const vid = `__e2e__${provider}_vote_delete`;
    const author = `${provider}-del-author`;
    const voter = `${provider}-del-voter`;
    const extra = prefix ? { duration: 300 } : { v: '1' };
    const voteExtra = prefix ? { prv_user_id: 1, duration: 300 } : {};
    const voterUser = prefix ? { prv_user_id: 1 } : {};

    await postMarkup(prefix, { video_id: vid, user_id: author, category_id: cat, ...extra, data: { intervals: [{ start: 1, end: 11 }] } });
    await postMarkup(prefix, {
        video_id: `${vid}_other`, user_id: voter, category_id: cat, ...extra, ...voterUser, data: { intervals: [{ start: 5, end: 9 }] },
    });
    runCalc(provider);

    const voteBase = { video_id: vid, category_id: cat, start: 1, end: 11, ...voteExtra };
    await postVote(prefix, { ...voteBase, user_id: `${provider}-del-other`, vote: 1 });
    const authorBefore = await userRating(prefix, author);
    const voterBefore = await userRating(prefix, voter);
    await postVote(prefix, { ...voteBase, user_id: voter, vote: -1 });
    assert.equal((await getSegmentRow(prefix, vid, cat, 1, 11)).rating, 0);
    assert.equal(await userRating(prefix, author), authorBefore - 1, 'the vote changed the author\'s rating');

    const voteId = await voteIdOf(prefix, voter, vid);
    const base = prefix ? `/${prefix}` : '';
    const res = await request('GET', `${base}/votes/${voteId}/delete?verifyBearerToken=${VOTE_AUTH}`, null);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    assert.equal((await getSegmentRow(prefix, vid, cat, 1, 11)).rating, 1, 'segment table rating back to the pre-vote value');
    assert.equal(await getJsonRating(prefix, vid, cat, 1, 11), 1, 'JSON rating back to the pre-vote value');
    assert.equal(await userRating(prefix, author), authorBefore, 'author\'s rating change reversed');
    assert.equal(await userRating(prefix, voter), voterBefore, 'voter\'s own rating untouched');
    const tp = prefix ? `${prefix}_` : '';
    assert.equal((await dbQuery(`SELECT 1 FROM ${tp}votes WHERE id = $1`, [voteId])).length, 0, 'vote row deleted');
}

test('prv vote delete: segment rating and author rating are reversed, the voter is untouched', async () => {
    await assertVoteDeleteUndoesVote('');
});

test('RT/YT vote delete: segment rating and author rating are reversed', async () => {
    await assertVoteDeleteUndoesVote('rt');
    await assertVoteDeleteUndoesVote('yt');
});

test('prv vote delete: unknown vote id → 404, wrong token → 401 and the vote stays', async () => {
    const missing = await request('GET', `/votes/999999999/delete?verifyBearerToken=${VOTE_AUTH}`, null);
    assert.equal(missing.status, 404);
    assert.equal((await request('GET', '/', null)).status, 200, 'server still up');

    const voteId = await voteIdOf('', 'prv-del-other', '__e2e__prv_vote_delete');
    const wrong = await request('GET', `/votes/${voteId}/delete?verifyBearerToken=wrong`, null);
    assert.equal(wrong.status, 401);
    assert.equal((await dbQuery(`SELECT 1 FROM votes WHERE id = $1`, [voteId])).length, 1, 'vote kept');
    assert.equal((await getSegmentRow('', '__e2e__prv_vote_delete', cats.prv.intro, 1, 11)).rating, 1, 'rating kept');
});

// ── update-rating (Grafana GET link) ──────────────────────────────────────────

test('update-rating: token checked first, rating must be an integer, the override is logged', async () => {
    const [{ id }] = await dbQuery(`SELECT id FROM users WHERE generated_user_id = 'prv-del-author'`);
    const before = await userRating('', 'prv-del-author');
    const url = (qs) => `/votes/user/${id}/update-rating?${qs}`;

    assert.equal((await request('GET', url(`verifyBearerToken=wrong&rating=abc`), null)).status, 401, 'wrong token before validation');
    assert.equal((await request('GET', url(`rating=5`), null)).status, 401, 'no token');
    for (const qs of ['', 'rating=', 'rating=abc', 'rating=1.5', 'rating=99999999999']) {
        const res = await request('GET', url(`verifyBearerToken=${VOTE_AUTH}&${qs}`), null);
        assert.equal(res.status, 400, `"${qs}" must be rejected, got ${res.status}`);
    }
    assert.equal(await userRating('', 'prv-del-author'), before, 'rejected requests change nothing');

    const unknown = await request('GET', `/votes/user/999999999/update-rating?verifyBearerToken=${VOTE_AUTH}&rating=1`, null);
    assert.equal(unknown.status, 404);

    let logged = '';
    const onData = d => (logged += d);
    serverProc.stdout.on('data', onData);
    try {
        const ok = await request('GET', url(`verifyBearerToken=${VOTE_AUTH}&rating=-7`), null);
        assert.equal(ok.status, 201);
        for (let i = 0; i < 50 && !logged.includes('Admin rating override'); i++) await sleep(20);
    } finally {
        serverProc.stdout.off('data', onData);
    }
    assert.equal(await userRating('', 'prv-del-author'), -7, 'stored as an integer');
    assert.match(logged, new RegExp(`Admin rating override.*internal_user_id: ${id}.*from: ${before}.*to: -7`, 's'));
});

// ── Metrics endpoint and path normalization ──────────────────────────────────

test('metrics: GET /metrics returns 200 and includes expected metric names', async () => {
    const text = await fetchMetrics();
    assert.ok(text.includes('video_calculated_lookup_total'), 'missing video_calculated_lookup_total');
    assert.ok(text.includes('request_without_version_total'), 'missing request_without_version_total');
    assert.ok(text.includes('http_request_duration_seconds'), 'missing http_request_duration_seconds');
});

test('metrics: /metrics is not recorded in http_request_duration_seconds', async () => {
    await fetchMetrics();
    await fetchMetrics();
    const text = await fetchMetrics();
    assert.ok(!httpDurationHasPath(text, '/metrics'), '/metrics path leaked into http_request_duration_seconds');
});

test('metrics: /admin/video/:video_id normalizes to a stable label', async () => {
    await request('GET', '/admin/video/12345', null);
    await request('GET', '/admin/video/67890', null);
    const text = await fetchMetrics();
    assert.ok(httpDurationHasPath(text, '/admin/video/#video_id'),
        'expected normalized path /admin/video/#video_id in metrics');
    assert.ok(!httpDurationHasPath(text, '/admin/video/12345'),
        'raw path /admin/video/12345 leaked into metrics (normalization failed)');
});

// ── /admin/video pages escape interpolated values ────────────────────────────

// native_id is whatever a client sends to POST /markup; both admin/video pages
// print it (and link to each other with it) next to the inline AUTH_TOKEN.
test('admin/video: an HTML/script payload in native_id is escaped on the video and user pages', async () => {
    const auth = process.env.AUTH_TOKEN || 'test_token';
    const vid = '__e2e__xss"><img src=x onerror=alert(1)></script><script>alert(2)</script>';
    const escaped = '__e2e__xss&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;/script&gt;&lt;script&gt;alert(2)&lt;/script&gt;';
    const prvUserId = 990417;
    await postMarkup('', {
        video_id: vid, v: '1', user_id: 'xss-author', prv_user_id: prvUserId, category_id: cats.prv.intro,
        data: { intervals: [{ start: 0, end: 10 }] },
    });
    runCalc('prv');

    const videoPage = await request('GET', `/admin/video/${encodeURIComponent(vid)}?verifyBearerToken=${auth}`, null);
    assert.equal(videoPage.status, 200);
    const videoHtml = videoPage.body;
    assert.ok(!videoHtml.includes(vid), 'raw payload must not reach the video page');
    assert.ok(!videoHtml.includes('<img'), 'payload <img> must not be rendered');
    assert.ok(videoHtml.includes(`<title>Video ${escaped}</title>`), 'escaped payload in <title>');
    assert.ok(videoHtml.includes(`<h1>Video: ${escaped}</h1>`), 'escaped payload in <h1>');
    assert.equal(videoHtml.split('<script>').length - 1, 1, 'only the page\'s own <script>');
    assert.equal(videoHtml.split('</script>').length - 1, 1, 'only the page\'s own </script>');
    assert.ok(videoHtml.includes(`const AUTH_TOKEN = ${JSON.stringify(auth)};`), 'token as a JSON string literal');
    const videoDbId = videoHtml.match(/<span>ID: (\d+)<\/span>/)[1];
    assert.ok(videoHtml.includes(`href="/admin/video/${videoDbId}/user/${prvUserId}?verifyBearerToken=${auth}"`),
        'user link on the segment row');

    const userPage = await request('GET', `/admin/video/${encodeURIComponent(vid)}/user/${prvUserId}?verifyBearerToken=${auth}`, null);
    assert.equal(userPage.status, 200);
    const userHtml = userPage.body;
    assert.ok(!userHtml.includes(vid), 'raw payload must not reach the user page');
    assert.ok(!userHtml.includes('<img'), 'payload <img> must not be rendered');
    assert.ok(userHtml.includes(`<title>User ${prvUserId} — Video ${escaped}</title>`), 'escaped payload in <title>');
    assert.ok(userHtml.includes(`<a href="/admin/video/${encodeURIComponent(vid)}?verifyBearerToken=${auth}">Video ${escaped}</a>`),
        'back link with the URL-encoded native_id and escaped text');
    assert.equal(userHtml.split('<script>').length - 1, 1, 'only the page\'s own <script>');
    assert.equal(userHtml.split('</script>').length - 1, 1, 'only the page\'s own </script>');
    assert.ok(userHtml.includes(`const AUTH_TOKEN = ${JSON.stringify(auth)};`), 'token as a JSON string literal');
});

test('metrics: DELETE /markups/:id normalizes to a stable label', async () => {
    await request('DELETE', '/markups/111', null);
    await request('DELETE', '/markups/222', null);
    const text = await fetchMetrics();
    assert.ok(httpDurationHasPath(text, '/markups/#id'),
        'expected normalized path /markups/#id in metrics');
    assert.ok(!httpDurationHasPath(text, '/markups/111'),
        'raw path /markups/111 leaked into metrics (normalization failed)');
});

// ── CORS headers ──────────────────────────────────────────────────────────────

// No endpoint uses cookies, so the reflected Origin must not come with
// Allow-Credentials (that pair would let any site make credentialed calls).
test('cors: the request Origin is reflected without Access-Control-Allow-Credentials', async () => {
    const headers = await new Promise((resolve, reject) => {
        const req = http.request(
            { hostname: 'localhost', port: E2E_PORT, path: '/', method: 'GET', headers: { Origin: 'https://example.test' } },
            res => { res.resume(); res.on('end', () => resolve(res.headers)); }
        );
        req.on('error', reject);
        req.end();
    });
    assert.equal(headers['access-control-allow-origin'], 'https://example.test');
    assert.equal(headers['access-control-allow-credentials'], undefined);
});

// ── /admin/moderation page tests ──────────────────────────────────────────────

const MOD_AUTH = process.env.AUTH_TOKEN || 'test_token';

async function getModerationJson(query = '') {
    const path = `/admin/moderation?format=json&verifyBearerToken=${encodeURIComponent(MOD_AUTH)}${query}`;
    return request('GET', path, null);
}

async function seedDislikeAgainst(videoNativeId, catId, start, end, authorUserId, voterId) {
    // Seed a prv markup authored by `authorUserId`, run calc, then POST a -1 vote by `voterId`.
    // Each dislike costs the author 1 rating point, so from the third markup on POST /markup would
    // hit the rating ≤ -2 gate and silently create nothing. Only the author's first markup goes over
    // HTTP (it creates the User row); later ones are seeded directly, like the auto-ban tests do.
    const internalUserId = await getAuthorInternalId(authorUserId);
    if (internalUserId) {
        await seedMarkupDirect({ videoNativeId, categoryId: catId, start, end, internalUserId, externalUserId: authorUserId });
    } else {
        await postMarkup('', { video_id: videoNativeId, v: '1', user_id: authorUserId, category_id: catId, data: { intervals: [{ start, end }] } });
    }
    runCalc('prv');
    await postVote('', { video_id: videoNativeId, user_id: voterId, category_id: catId, start, end, vote: -1 });
}

test('moderation: GET without token returns 401', async () => {
    const res = await request('GET', '/admin/moderation', null);
    assert.equal(res.status, 401);
});

test('moderation: JSON response has all 6 top-level keys', async () => {
    const res = await getModerationJson();
    assert.equal(res.status, 200);
    assert.ok(res.body && typeof res.body === 'object', `unexpected body: ${JSON.stringify(res.body)}`);
    const keys = Object.keys(res.body).sort();
    assert.deepEqual(keys, ['history', 'markups', 'recent_dislikes', 'recent_undos', 'users', 'video_integrity'].sort());
    assert.ok(Array.isArray(res.body.users), 'users must be array');
    assert.ok(Array.isArray(res.body.markups), 'markups must be array');
    assert.ok(Array.isArray(res.body.recent_dislikes), 'recent_dislikes must be array');
    assert.ok(Array.isArray(res.body.recent_undos), 'recent_undos must be array');
    assert.ok(res.body.video_integrity && Array.isArray(res.body.video_integrity.duplicate_native_id), 'video_integrity.duplicate_native_id must be array');
    assert.ok(Array.isArray(res.body.video_integrity.duration_outliers), 'video_integrity.duration_outliers must be array');
    assert.ok(Array.isArray(res.body.history), 'history must be array');
});

test('moderation: users[] sorted by score desc, fields match contract', async () => {
    // Seed two users with different signal counts so scoreboard has order.
    const vid = '__e2e__mod_users_order';
    const cat = cats.prv.intro;
    // Author A: 3 dislikes across 3 segments
    await seedDislikeAgainst(vid, cat, 0, 10, 'mod-author-a', 'mod-voter-1');
    await seedDislikeAgainst(vid, cat, 30, 40, 'mod-author-a', 'mod-voter-2');
    await seedDislikeAgainst(vid, cat, 60, 70, 'mod-author-a', 'mod-voter-3');
    // Author B: 1 dislike
    await seedDislikeAgainst(vid + '_b', cat, 0, 10, 'mod-author-b', 'mod-voter-4');

    const res = await getModerationJson();
    assert.equal(res.status, 200);
    const users = res.body.users;
    assert.ok(users.length >= 2, `expected at least 2 users, got ${users.length}`);
    // sorted desc by score
    for (let i = 1; i < users.length; i++) {
        assert.ok(users[i - 1].score >= users[i].score, `users not sorted desc: ${JSON.stringify(users.map(u => u.score))}`);
    }
    // Contract field check on the top row
    const top = users[0];
    const expectedKeys = ['user_id', 'prv_user_id', 'score', 'dislikes', 'dislikes_7d', 'undos', 'undos_7d',
        'rating', 'markups_total', 'markups_recent', 'banned_at', 'last_decision'];
    for (const k of expectedKeys) {
        assert.ok(Object.prototype.hasOwnProperty.call(top, k), `users[0] missing field: ${k}`);
    }
});

test('moderation: markups[] row carries the contract fields', async () => {
    const vid = '__e2e__mod_markup_fields';
    const cat = cats.prv.intro;
    await seedDislikeAgainst(vid, cat, 0, 10, 'mod-markup-author', 'mod-markup-voter');

    const res = await getModerationJson();
    assert.equal(res.status, 200);
    const markups = res.body.markups;
    assert.ok(markups.length >= 1, 'expected at least one markup on scoreboard');
    const expectedKeys = ['markup_id', 'score', 'dislikes', 'dislikes_7d', 'undos', 'undos_7d',
        'segment_rating', 'user_id', 'prv_user_id', 'video_id', 'video_native_id', 'last_decision'];
    for (const k of expectedKeys) {
        assert.ok(Object.prototype.hasOwnProperty.call(markups[0], k), `markups[0] missing field: ${k}`);
    }
});

test('moderation: default view hides decided row whose snapshot.score == current score', async () => {
    const vid = '__e2e__mod_hide_decided';
    const cat = cats.prv.intro;
    await seedDislikeAgainst(vid, cat, 0, 10, 'mod-hide-author', 'mod-hide-voter');

    // Find the user via a JSON snapshot first.
    const before = await getModerationJson();
    assert.equal(before.status, 200);
    const target = before.body.users.find(u => u.dislikes >= 1);
    assert.ok(target, `expected a seeded user in scoreboard: ${JSON.stringify(before.body.users)}`);

    // Insert an admin-decision row whose snapshot.score matches the current score
    // (i.e. delta = 0, below the threshold of 5 → row must be hidden by default).
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query(
            `INSERT INTO prv_admin_decisions (target_type, target_id, decision, signals_snapshot, decided_at, decided_by)
             VALUES ('user', $1, 'approve', $2, NOW(), 'admin')`,
            [target.user_id, JSON.stringify({ score: target.score, dislikes: target.dislikes, undos: target.undos })]
        );
    } finally {
        await c.end();
    }

    // Default view: target must be hidden.
    const hidden = await getModerationJson();
    assert.equal(hidden.status, 200);
    const stillThere = hidden.body.users.find(u => u.user_id === target.user_id);
    assert.equal(stillThere, undefined, `decided user should be hidden by default, found: ${JSON.stringify(stillThere)}`);

    // show=all reveals it again.
    const all = await getModerationJson('&show=all');
    assert.equal(all.status, 200);
    const reappeared = all.body.users.find(u => u.user_id === target.user_id);
    assert.ok(reappeared, 'show=all must reveal the decided row');
    assert.ok(reappeared.last_decision, 'last_decision should be populated on the row');
});

// ── POST /admin/moderation/decide tests ───────────────────────────────────────

async function postDecide(payload, { token } = {}) {
    const t = token === undefined ? MOD_AUTH : token;
    const qs = t == null ? '' : `?verifyBearerToken=${encodeURIComponent(t)}`;
    return request('POST', `/admin/moderation/decide${qs}`, payload);
}

async function countDecisions(target_type, target_id) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT COUNT(*)::int AS n FROM prv_admin_decisions WHERE target_type=$1 AND target_id=$2`,
            [target_type, target_id]
        );
        return rows[0].n;
    } finally {
        await c.end();
    }
}

async function selectLatestDecision(target_type, target_id) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT id, target_type, target_id, decision, signals_snapshot, decided_at, decided_by
             FROM prv_admin_decisions WHERE target_type=$1 AND target_id=$2
             ORDER BY decided_at DESC, id DESC LIMIT 1`,
            [target_type, target_id]
        );
        return rows[0] || null;
    } finally {
        await c.end();
    }
}

async function selectAllDecisions(target_type, target_id) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT id, target_type, target_id, decision, signals_snapshot, decided_at, decided_by
             FROM prv_admin_decisions WHERE target_type=$1 AND target_id=$2
             ORDER BY decided_at ASC, id ASC`,
            [target_type, target_id]
        );
        return rows;
    } finally {
        await c.end();
    }
}

async function selectUser(internalId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(`SELECT id, banned_at, rating FROM users WHERE id=$1`, [internalId]);
        return rows[0] || null;
    } finally {
        await c.end();
    }
}

async function selectMarkup(markupId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT id, video_id, deleted_at, is_new FROM markups WHERE id=$1`, [markupId]
        );
        return rows[0] || null;
    } finally {
        await c.end();
    }
}

async function selectVideoCalculatedRowCount(videoId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT COUNT(*)::int AS n FROM video_calculateds WHERE video_id=$1`, [videoId]
        );
        return rows[0].n;
    } finally {
        await c.end();
    }
}

async function getAuthorInternalId(userExternalId) {
    // Markups carry internal_user_id; we resolve it via the markup row.
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT internal_user_id FROM markups WHERE user_id=$1 ORDER BY id DESC LIMIT 1`,
            [userExternalId]
        );
        return rows[0] ? rows[0].internal_user_id : null;
    } finally {
        await c.end();
    }
}

async function getMarkupsByVideoNative(nativeId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT m.id, m.video_id, m.deleted_at, m.is_new
             FROM markups m JOIN videos v ON v.id = m.video_id
             WHERE v.native_id=$1 ORDER BY m.id ASC`,
            [nativeId]
        );
        return rows;
    } finally {
        await c.end();
    }
}

test('moderation: POST /decide without verifyBearerToken returns 401', async () => {
    // Seed a user we can target so we can verify NO state change happened.
    const vid = '__e2e__mod_decide_401';
    await seedDislikeAgainst(vid, cats.prv.intro, 0, 10, 'mod-decide-401-author', 'mod-decide-401-voter');
    const authorInternalId = await getAuthorInternalId('mod-decide-401-author');
    assert.ok(authorInternalId, 'pre-condition: author must have internal id');

    const beforeCount = await countDecisions('user', authorInternalId);
    const beforeUser = await selectUser(authorInternalId);
    assert.equal(beforeUser.banned_at, null, 'pre-condition: user not banned');

    // No token → 401.
    const noToken = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'reject' }, { token: null });
    assert.equal(noToken.status, 401);

    // Wrong token → 401.
    const wrongToken = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'reject' }, { token: 'definitely-wrong' });
    assert.equal(wrongToken.status, 401);

    // No decision row written, no banned_at change.
    const afterCount = await countDecisions('user', authorInternalId);
    assert.equal(afterCount, beforeCount, 'no decision row should have been written');
    const afterUser = await selectUser(authorInternalId);
    assert.equal(afterUser.banned_at, null, 'banned_at must remain null');
});

test('moderation: POST /decide markup+reject with siblings soft-deletes only the target', async () => {
    // Seed a video with 2 markups (different starts so they bucket apart) so siblings exist.
    const vid = '__e2e__mod_decide_markup_siblings';
    const cat = cats.prv.intro;
    const base = { video_id: vid, v: '1', user_id: 'mod-mreject-author', category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, data: { intervals: [{ start: 30, end: 40 }] } });
    runCalc('prv');

    const allMarkups = await getMarkupsByVideoNative(vid);
    assert.equal(allMarkups.length, 2, `expected 2 markups, got ${allMarkups.length}`);
    const target = allMarkups[0];
    const sibling = allMarkups[1];
    const videoId = target.video_id;

    // Pre-condition: VideoCalculated row exists.
    assert.equal(await selectVideoCalculatedRowCount(videoId), 1, 'pre: VideoCalculated row exists');

    const res = await postDecide({ target_type: 'markup', target_id: target.id, decision: 'reject' });
    assert.equal(res.status, 204, `expected 204, got ${res.status} ${JSON.stringify(res.body)}`);

    // Target soft-deleted.
    const afterTarget = await selectMarkup(target.id);
    assert.ok(afterTarget.deleted_at, `target markup must be soft-deleted: ${JSON.stringify(afterTarget)}`);

    // Sibling is_new flipped to true (kicks calculator).
    const afterSibling = await selectMarkup(sibling.id);
    assert.equal(afterSibling.is_new, true, 'sibling must have is_new=true');
    assert.equal(afterSibling.deleted_at, null, 'sibling must NOT be soft-deleted');

    // VideoCalculated row still exists.
    assert.equal(await selectVideoCalculatedRowCount(videoId), 1, 'VideoCalculated row must still exist');

    // Decision row written with snapshot.
    const decision = await selectLatestDecision('markup', target.id);
    assert.ok(decision, 'decision row must exist');
    assert.equal(decision.decision, 'reject');
    assert.equal(decision.decided_by, 'admin');
    assert.ok(decision.signals_snapshot, 'signals_snapshot must be present');
});

test('moderation: POST /decide markup+reject with no siblings destroys VideoCalculated', async () => {
    // Seed a video with exactly 1 markup. After soft-delete + sibling-check, no
    // non-deleted markups remain → branch B (VideoCalculated.destroy).
    const vid = '__e2e__mod_decide_markup_no_siblings';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'mod-mreject-solo', category_id: cat, data: { intervals: [{ start: 0, end: 10 }] } });
    runCalc('prv');

    const markups = await getMarkupsByVideoNative(vid);
    assert.equal(markups.length, 1, `expected 1 markup, got ${markups.length}`);
    const target = markups[0];
    const videoId = target.video_id;

    assert.equal(await selectVideoCalculatedRowCount(videoId), 1, 'pre: VideoCalculated row exists');

    const res = await postDecide({ target_type: 'markup', target_id: target.id, decision: 'reject' });
    assert.equal(res.status, 204, `expected 204, got ${res.status} ${JSON.stringify(res.body)}`);

    const afterTarget = await selectMarkup(target.id);
    assert.ok(afterTarget.deleted_at, 'target markup must be soft-deleted');

    // VideoCalculated row destroyed.
    assert.equal(await selectVideoCalculatedRowCount(videoId), 0, 'VideoCalculated row must be destroyed');

    const decision = await selectLatestDecision('markup', target.id);
    assert.ok(decision, 'decision row must exist');
    assert.equal(decision.decision, 'reject');
    assert.equal(decision.decided_by, 'admin');
});

test('moderation: POST /decide user+reject sets banned_at and inserts decision row', async () => {
    const vid = '__e2e__mod_decide_user_reject';
    await seedDislikeAgainst(vid, cats.prv.intro, 0, 10, 'mod-ureject-author', 'mod-ureject-voter');
    const authorInternalId = await getAuthorInternalId('mod-ureject-author');
    assert.ok(authorInternalId, 'pre: author has internal id');

    const before = await selectUser(authorInternalId);
    assert.equal(before.banned_at, null, 'pre: user not banned');

    const res = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'reject' });
    assert.equal(res.status, 204, `expected 204, got ${res.status} ${JSON.stringify(res.body)}`);

    const after = await selectUser(authorInternalId);
    assert.ok(after.banned_at, `user.banned_at must be set, got ${after.banned_at}`);

    const decision = await selectLatestDecision('user', authorInternalId);
    assert.ok(decision, 'decision row must exist');
    assert.equal(decision.decision, 'reject');
    assert.equal(decision.decided_by, 'admin');
});

test('moderation: POST /decide user+approve clears banned_at', async () => {
    const vid = '__e2e__mod_decide_user_approve';
    await seedDislikeAgainst(vid, cats.prv.intro, 0, 10, 'mod-uapprove-author', 'mod-uapprove-voter');
    const authorInternalId = await getAuthorInternalId('mod-uapprove-author');
    assert.ok(authorInternalId, 'pre: author has internal id');

    // Pre-set banned_at directly so we exercise the unban path.
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query(`UPDATE users SET banned_at = NOW() WHERE id = $1`, [authorInternalId]);
    } finally {
        await c.end();
    }
    const before = await selectUser(authorInternalId);
    assert.ok(before.banned_at, 'pre: user must be banned');

    const res = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'approve' });
    assert.equal(res.status, 204, `expected 204, got ${res.status} ${JSON.stringify(res.body)}`);

    const after = await selectUser(authorInternalId);
    assert.equal(after.banned_at, null, 'banned_at must be cleared on approve');

    const decision = await selectLatestDecision('user', authorInternalId);
    assert.ok(decision, 'decision row must exist');
    assert.equal(decision.decision, 'approve');
    assert.equal(decision.decided_by, 'admin');
});

test('moderation: POST /decide with missing target_type returns 400', async () => {
    const res = await postDecide({ target_id: 1, decision: 'reject' });
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
});

test('moderation: POST /decide with non-object body returns 400', async () => {
    // null body
    const r1 = await postDecide(null);
    assert.equal(r1.status, 400, 'null body should be 400');
    // array body
    const r2 = await postDecide([{ target_type: 'user', target_id: 1, decision: 'reject' }]);
    assert.equal(r2.status, 400, 'array body should be 400');
});

test('moderation: POST /decide with invalid decision value returns 400', async () => {
    const res = await postDecide({ target_type: 'user', target_id: 1, decision: 'maybe' });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
});

test('moderation: POST /decide with invalid target_id returns 400', async () => {
    const nonInt = await postDecide({ target_type: 'user', target_id: 'abc', decision: 'reject' });
    assert.equal(nonInt.status, 400, 'non-integer target_id should be 400');
    const zero = await postDecide({ target_type: 'user', target_id: 0, decision: 'reject' });
    assert.equal(zero.status, 400, 'zero target_id should be 400');
    const negative = await postDecide({ target_type: 'user', target_id: -5, decision: 'reject' });
    assert.equal(negative.status, 400, 'negative target_id should be 400');
});

test('moderation: POST /decide missing target_id returns 400', async () => {
    const res = await postDecide({ target_type: 'user', decision: 'reject' });
    assert.equal(res.status, 400, `expected 400, got ${res.status}`);
});

test('moderation: POST /decide on missing user target returns 404 with no decision row', async () => {
    const missingId = 999999999;
    const before = await countDecisions('user', missingId);
    const res = await postDecide({ target_type: 'user', target_id: missingId, decision: 'reject' });
    assert.equal(res.status, 404, `expected 404, got ${res.status} ${JSON.stringify(res.body)}`);
    const after = await countDecisions('user', missingId);
    assert.equal(after, before, 'no decision row should be inserted for missing user');
});

test('moderation: POST /decide on missing markup target returns 404 with no decision row', async () => {
    const missingId = 999999999;
    const before = await countDecisions('markup', missingId);
    const res = await postDecide({ target_type: 'markup', target_id: missingId, decision: 'reject' });
    assert.equal(res.status, 404, `expected 404, got ${res.status} ${JSON.stringify(res.body)}`);
    const after = await countDecisions('markup', missingId);
    assert.equal(after, before, 'no decision row should be inserted for missing markup');
});

test('moderation: POST /decide markup+approve is a no-op besides the decision row', async () => {
    // Seed a single markup so we have a target.
    const vid = '__e2e__mod_decide_markup_approve';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'mod-mapprove-author', category_id: cat, data: { intervals: [{ start: 0, end: 10 }] } });
    runCalc('prv');

    const allMarkups = await getMarkupsByVideoNative(vid);
    assert.equal(allMarkups.length, 1, `expected 1 markup, got ${allMarkups.length}`);
    const target = allMarkups[0];
    const beforeDeleted = target.deleted_at;

    const res = await postDecide({ target_type: 'markup', target_id: target.id, decision: 'approve' });
    assert.equal(res.status, 204, `expected 204, got ${res.status} ${JSON.stringify(res.body)}`);

    // Markup row still exists, not soft-deleted.
    const after = await selectMarkup(target.id);
    assert.ok(after, 'markup row must still exist after approve');
    assert.equal(after.deleted_at, beforeDeleted, 'markup must NOT be soft-deleted on approve');

    // Sibling list unchanged.
    const afterMarkups = await getMarkupsByVideoNative(vid);
    assert.equal(afterMarkups.length, 1, 'sibling list should be unchanged');

    // Exactly one decision row exists.
    const decisions = await selectAllDecisions('markup', target.id);
    assert.equal(decisions.length, 1, 'exactly one decision row should exist');
    assert.equal(decisions[0].decision, 'approve');
    assert.equal(decisions[0].decided_by, 'admin');
    assert.ok(decisions[0].signals_snapshot, 'signals_snapshot must be present');
});

test('moderation: GET /admin/moderation HTML smoke test (200, text/html, contains key markers)', async () => {
    const path = `/admin/moderation?verifyBearerToken=${encodeURIComponent(process.env.AUTH_TOKEN || 'change-me')}`;
    const res = await request('GET', path, null);
    assert.equal(res.status, 200);
    // Body should be a string (HTML), not parsed JSON.
    assert.equal(typeof res.body, 'string', 'HTML response body must be a string');
    // Key DOM markers per plan: AJAX decide() hook, scoreboard headings.
    assert.ok(res.body.includes('<h1>Moderation</h1>'), 'page must contain the Moderation header');
    assert.ok(res.body.includes('async function decide('), 'page must include the decide() JS hook');
    assert.ok(res.body.includes('AUTH_TOKEN'), 'page must include the AUTH_TOKEN inline binding');
    // Sanity: response is HTML.
    // (We can't directly inspect headers from this helper, but body shape is decisive.)
});

// ── Re-surface threshold behavior ─────────────────────────────────────────────
//
// Score formula for users is `3*dislikes + 1*undos`, so each fresh -1 vote adds 3
// to the current score. RESURFACE_THRESHOLD = 5 in prv/routes/admin-moderation.js,
// so after a decision the row reappears only once `current_score - snapshot.score >= 5`
// (i.e. needs ≥ 2 fresh dislikes after the snapshot, since 3*2=6 ≥ 5).

test('moderation: re-surface after enough new dislikes (3 → approve → +1 hidden → +1 re-surface)', async () => {
    const vid = '__e2e__mod_resurface_users';
    const cat = cats.prv.intro;
    const author = 'mod-resurface-author';
    // Three dislikes on three different (start, end) tuples — each post-vote increments score by 3.
    await seedDislikeAgainst(vid, cat, 0,  10, author, 'mod-resurface-v1');
    await seedDislikeAgainst(vid, cat, 30, 40, author, 'mod-resurface-v2');
    await seedDislikeAgainst(vid, cat, 60, 70, author, 'mod-resurface-v3');

    // Sanity: user is on the scoreboard with score 9.
    const authorInternalId = await getAuthorInternalId(author);
    assert.ok(authorInternalId, 'pre: author has internal id');
    const initial = await getModerationJson();
    assert.equal(initial.status, 200);
    const target = initial.body.users.find(u => u.user_id === authorInternalId);
    assert.ok(target, `expected seeded user on scoreboard: ${JSON.stringify(initial.body.users)}`);
    assert.equal(target.dislikes, 3, `expected 3 dislikes, got ${target.dislikes}`);
    assert.equal(target.score, 9, `score should be 3*3 = 9, got ${target.score}`);

    // Snapshot the user via approve → snapshot.score = 9, delta = 0.
    const approveRes = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'approve' });
    assert.equal(approveRes.status, 204, `expected 204, got ${approveRes.status} ${JSON.stringify(approveRes.body)}`);

    // Verify snapshot.score was captured at 9.
    const decision = await selectLatestDecision('user', authorInternalId);
    assert.ok(decision, 'approve decision row must exist');
    assert.equal(decision.signals_snapshot && decision.signals_snapshot.score, 9,
        `snapshot.score should be 9, got ${JSON.stringify(decision.signals_snapshot)}`);

    // After approve: default view hides the user (delta = 9 - 9 = 0 < 5).
    const afterApprove = await getModerationJson();
    assert.equal(afterApprove.status, 200);
    const hidden1 = afterApprove.body.users.find(u => u.user_id === authorInternalId);
    assert.equal(hidden1, undefined,
        `user must be hidden after approve (delta=0): ${JSON.stringify(hidden1)}`);

    // +1 dislike → current score 12, delta = 3 < 5 → still hidden.
    await seedDislikeAgainst(vid + '_b', cat, 0, 10, author, 'mod-resurface-v4');
    const afterOneMore = await getModerationJson();
    assert.equal(afterOneMore.status, 200);
    const hidden2 = afterOneMore.body.users.find(u => u.user_id === authorInternalId);
    assert.equal(hidden2, undefined,
        `user must remain hidden after 1 new dislike (delta=3 < 5): ${JSON.stringify(hidden2)}`);

    // +1 more dislike → current score 15, delta = 6 ≥ 5 → re-surfaces.
    await seedDislikeAgainst(vid + '_c', cat, 0, 10, author, 'mod-resurface-v5');
    const afterTwoMore = await getModerationJson();
    assert.equal(afterTwoMore.status, 200);
    const visible = afterTwoMore.body.users.find(u => u.user_id === authorInternalId);
    assert.ok(visible, `user must re-surface after 2 new dislikes (delta=6 ≥ 5): ${JSON.stringify(afterTwoMore.body.users)}`);
    assert.equal(visible.score, 15, `re-surfaced user score should be 5*3 = 15, got ${visible.score}`);
});

test('moderation: ?show=all reveals approved user regardless of delta', async () => {
    const vid = '__e2e__mod_resurface_showall';
    const cat = cats.prv.intro;
    const author = 'mod-resurface-showall-author';
    // 3 dislikes against this author.
    await seedDislikeAgainst(vid, cat, 0,  10, author, 'mod-showall-v1');
    await seedDislikeAgainst(vid, cat, 30, 40, author, 'mod-showall-v2');
    await seedDislikeAgainst(vid, cat, 60, 70, author, 'mod-showall-v3');

    const authorInternalId = await getAuthorInternalId(author);
    assert.ok(authorInternalId, 'pre: author has internal id');

    // Approve → user hidden by default.
    const approveRes = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'approve' });
    assert.equal(approveRes.status, 204);

    // Default view: hidden.
    const def = await getModerationJson();
    assert.equal(def.status, 200);
    const hidden = def.body.users.find(u => u.user_id === authorInternalId);
    assert.equal(hidden, undefined, 'approved user must be hidden by default');

    // ?show=all: revealed, last_decision populated.
    const all = await getModerationJson('&show=all');
    assert.equal(all.status, 200);
    const revealed = all.body.users.find(u => u.user_id === authorInternalId);
    assert.ok(revealed, `show=all must reveal approved user: ${JSON.stringify(all.body.users)}`);
    assert.ok(revealed.last_decision, 'last_decision should be populated on revealed row');
    assert.equal(revealed.last_decision.decision, 'approve');
});

// ── Auto-ban hook tests ───────────────────────────────────────────────────────
//
// The auto-ban hook lives in prv/service/user.js:updateRatingByVote. When a user's
// rating drops to ≤ -100 (AUTO_BAN_RATING_THRESHOLD) AND banned_at is null, the
// service sets banned_at = NOW() and writes a `prv_admin_decisions` row with
// decided_by='auto' via the same recordDecision entrypoint as the admin POST.
//
// To exercise it cheaply, we:
//   1. seed a -1 vote against an author's markup (one HTTP roundtrip via
//      seedDislikeAgainst); this creates the User row and the segment.
//   2. fast-forward the author's rating directly in DB to just-above threshold
//      (-99). The auto-ban guard only fires inside the POST /vote handler.
//   3. send ONE more -1 vote (on a fresh segment / voter) to cross the threshold.

async function setUserRating(internalId, rating) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query(`UPDATE users SET rating = $1 WHERE id = $2`, [rating, internalId]);
    } finally {
        await c.end();
    }
}

async function setUserBannedAt(internalId, when) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query(`UPDATE users SET banned_at = $1 WHERE id = $2`, [when, internalId]);
    } finally {
        await c.end();
    }
}

async function countAutoDecisions(internalId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT COUNT(*)::int AS n FROM prv_admin_decisions
             WHERE target_type='user' AND target_id=$1 AND decided_by='auto'`,
            [internalId]
        );
        return rows[0].n;
    } finally {
        await c.end();
    }
}

// Direct-DB markup seeding — bypasses the HTTP POST /markup rating gate (which
// silently 201s when rating ≤ -2). The auto-ban tests need to author additional
// markups AFTER setting the author's rating below -2, so they must skip the gate.
// Inserts the video (idempotent on native_id), the markup, and the interval; the
// caller still runs `runCalc('prv')` to produce the segment.
async function seedMarkupDirect({ videoNativeId, categoryId, start, end, internalUserId, externalUserId }) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        // upsert video by native_id
        const { rows: existingVideos } = await c.query(
            `SELECT id FROM videos WHERE native_id = $1 LIMIT 1`, [videoNativeId]
        );
        let videoId;
        if (existingVideos.length > 0) {
            videoId = existingVideos[0].id;
        } else {
            const { rows: ins } = await c.query(
                `INSERT INTO videos (native_id, "createdAt", "updatedAt") VALUES ($1, NOW(), NOW()) RETURNING id`,
                [videoNativeId]
            );
            videoId = ins[0].id;
        }
        const { rows: mIns } = await c.query(
            `INSERT INTO markups (video_id, user_id, internal_user_id, category_id, is_new, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, true, NOW(), NOW()) RETURNING id`,
            [videoId, externalUserId, internalUserId, categoryId]
        );
        const markupId = mIns[0].id;
        await c.query(
            `INSERT INTO markup_time_intervals (markup_id, start, "end", "createdAt", "updatedAt")
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [markupId, start, end]
        );
        return { videoId, markupId };
    } finally {
        await c.end();
    }
}

test('auto-ban: rating ≤ -100 sets banned_at and writes exactly one auto decision', async () => {
    // Step 1: seed an author + one dislike so a User row exists and we have a
    // segment for the threshold-crossing vote.
    const vid = '__e2e__autoban_basic';
    const cat = cats.prv.intro;
    const author = 'autoban-basic-author';
    await seedDislikeAgainst(vid, cat, 0, 10, author, 'autoban-basic-voter-seed');

    const internalId = await getAuthorInternalId(author);
    assert.ok(internalId, 'pre: author has internal id');

    // Pre-condition: not banned, no auto decision row yet.
    const before = await selectUser(internalId);
    assert.equal(before.banned_at, null, 'pre: banned_at must be null');
    assert.equal(await countAutoDecisions(internalId), 0, 'pre: no auto decision rows yet');

    // Step 2: fast-forward rating to -99 so a single -1 vote crosses the threshold.
    await setUserRating(internalId, -99);

    // Step 3: seed a fresh markup DIRECTLY in DB (HTTP POST /markup would be
    // silently rejected by the rating ≤ -2 gate now that we set rating=-99).
    // Then run calc to materialize the segment, then send the threshold-crossing
    // -1 vote.
    const vid2 = vid + '_cross';
    await seedMarkupDirect({ videoNativeId: vid2, categoryId: cat, start: 100, end: 110, internalUserId: internalId, externalUserId: author });
    runCalc('prv');
    await postVote('', { video_id: vid2, user_id: 'autoban-basic-voter-cross', category_id: cat, start: 100, end: 110, vote: -1 });

    // Assert: banned_at set, exactly ONE auto decision row exists.
    const after = await selectUser(internalId);
    assert.ok(after.banned_at, `banned_at must be set after rating crosses -100, got ${after.banned_at}`);
    assert.ok(after.rating <= -100, `rating must be ≤ -100, got ${after.rating}`);
    assert.equal(await countAutoDecisions(internalId), 1, 'exactly one auto decision row must exist');

    const decision = await selectLatestDecision('user', internalId);
    assert.ok(decision, 'auto decision row must exist');
    assert.equal(decision.decision, 'reject');
    assert.equal(decision.decided_by, 'auto');
    assert.equal(decision.target_type, 'user');
    assert.equal(decision.target_id, internalId);
});

test('auto-ban: idempotent under repeated threshold crossings (no duplicate auto rows)', async () => {
    // Seed author + one dislike to materialize the User row.
    const vid = '__e2e__autoban_idempotent';
    const cat = cats.prv.intro;
    const author = 'autoban-idem-author';
    await seedDislikeAgainst(vid, cat, 0, 10, author, 'autoban-idem-voter-seed');

    const internalId = await getAuthorInternalId(author);
    assert.ok(internalId, 'pre: author has internal id');

    // Fast-forward to -99 → first crossing vote drops rating to -100 and bans.
    await setUserRating(internalId, -99);

    // Direct-DB markup (rating gate would block HTTP POST). See seedMarkupDirect note.
    const vid2 = vid + '_first';
    await seedMarkupDirect({ videoNativeId: vid2, categoryId: cat, start: 100, end: 110, internalUserId: internalId, externalUserId: author });
    runCalc('prv');
    await postVote('', { video_id: vid2, user_id: 'autoban-idem-voter-1', category_id: cat, start: 100, end: 110, vote: -1 });

    const afterFirst = await selectUser(internalId);
    assert.ok(afterFirst.banned_at, 'banned_at must be set after first crossing');
    const firstBannedAt = afterFirst.banned_at;
    assert.equal(await countAutoDecisions(internalId), 1, 'first crossing writes exactly 1 auto row');

    // Drive rating further down to -120: 20 more -1 votes against fresh segments.
    // Each fresh segment has a unique (start, end), so prevVote is null and each
    // vote yields diffCount = -1. After all 20 votes rating should be ≤ -120.
    for (let i = 0; i < 20; i++) {
        const v = vid + `_drop_${i}`;
        const start = 200 + i * 5;
        const end = start + 10;
        await seedMarkupDirect({ videoNativeId: v, categoryId: cat, start, end, internalUserId: internalId, externalUserId: author });
        runCalc('prv');
        await postVote('', { video_id: v, user_id: `autoban-idem-voter-extra-${i}`, category_id: cat, start, end, vote: -1 });
    }

    // Assert: still exactly ONE auto decision row, banned_at unchanged.
    const afterRepeat = await selectUser(internalId);
    assert.ok(afterRepeat.rating <= -120, `rating must be ≤ -120 after extra votes, got ${afterRepeat.rating}`);
    assert.equal(
        new Date(afterRepeat.banned_at).getTime(),
        new Date(firstBannedAt).getTime(),
        `banned_at must be unchanged from first crossing (got ${afterRepeat.banned_at}, expected ${firstBannedAt})`
    );
    assert.equal(await countAutoDecisions(internalId), 1, 'still exactly 1 auto decision row after repeated crossings');
});

test('auto-ban: manually banned user — no duplicate auto decision row on threshold crossing', async () => {
    // Seed author so a User row exists.
    const vid = '__e2e__autoban_manual_already_banned';
    const cat = cats.prv.intro;
    const author = 'autoban-manual-author';
    await seedDislikeAgainst(vid, cat, 0, 10, author, 'autoban-manual-voter-seed');

    const internalId = await getAuthorInternalId(author);
    assert.ok(internalId, 'pre: author has internal id');

    // Pre-set: banned_at populated (manual ban via admin), rating well above -100.
    await setUserBannedAt(internalId, new Date('2024-01-01T00:00:00Z'));
    await setUserRating(internalId, -50);
    const before = await selectUser(internalId);
    assert.ok(before.banned_at, 'pre: banned_at must be set');
    const preBannedAt = before.banned_at;

    // Pre-count auto decisions (should be 0 — we only manually set banned_at,
    // didn't insert a decision row).
    const preAutoCount = await countAutoDecisions(internalId);
    assert.equal(preAutoCount, 0, 'pre: no auto decision rows from prior tests');

    // Drive rating below -100 via 60 -1 votes against fresh segments. Each vote
    // touches updateRatingByVote, which re-evaluates the auto-ban guard. Because
    // banned_at != null on every iteration, the guard must short-circuit.
    // Direct-DB markup seeding bypasses the HTTP rating gate (would block at -50).
    // We are at -50 here so HTTP would still work, but we use direct seeding for
    // consistency with the other auto-ban tests and to avoid a regression if the
    // gate threshold changes.
    for (let i = 0; i < 60; i++) {
        const v = vid + `_drop_${i}`;
        const start = 200 + i * 5;
        const end = start + 10;
        await seedMarkupDirect({ videoNativeId: v, categoryId: cat, start, end, internalUserId: internalId, externalUserId: author });
        runCalc('prv');
        await postVote('', { video_id: v, user_id: `autoban-manual-voter-${i}`, category_id: cat, start, end, vote: -1 });
    }

    // Assert: rating crossed but NO new auto decision row, banned_at unchanged.
    const after = await selectUser(internalId);
    assert.ok(after.rating <= -100, `rating must have crossed -100, got ${after.rating}`);
    assert.equal(
        new Date(after.banned_at).getTime(),
        new Date(preBannedAt).getTime(),
        `banned_at must be unchanged (got ${after.banned_at}, expected ${preBannedAt})`
    );
    assert.equal(await countAutoDecisions(internalId), 0, 'no auto decision row may appear when user was already banned');
});

test('moderation: approved user with 0 new signals stays hidden across repeated GETs', async () => {
    const vid = '__e2e__mod_resurface_zero_delta';
    const cat = cats.prv.intro;
    const author = 'mod-resurface-zero-author';
    // Seed 2 dislikes (score=6) so the user lands on the scoreboard initially.
    await seedDislikeAgainst(vid, cat, 0,  10, author, 'mod-zero-v1');
    await seedDislikeAgainst(vid, cat, 30, 40, author, 'mod-zero-v2');

    const authorInternalId = await getAuthorInternalId(author);
    assert.ok(authorInternalId, 'pre: author has internal id');

    // Approve → snapshot.score should equal current score (6).
    const approveRes = await postDecide({ target_type: 'user', target_id: authorInternalId, decision: 'approve' });
    assert.equal(approveRes.status, 204);

    // No new signals → user stays hidden across multiple GETs.
    for (let i = 0; i < 3; i++) {
        const res = await getModerationJson();
        assert.equal(res.status, 200);
        const found = res.body.users.find(u => u.user_id === authorInternalId);
        assert.equal(found, undefined,
            `iteration ${i}: approved user must stay hidden with 0 new signals (found ${JSON.stringify(found)})`);
    }
});

// ── Banned-user gate tests ────────────────────────────────────────────────────
//
// `POST /markup` has two parallel silent-success gates:
//   1. user.rating <= -2  → community soft-gate (existing)
//   2. user.banned_at != null → admin/auto hard-gate (Task 9)
// Both return 201 without creating a Markup row to avoid leaking the gate
// state to the client. These tests verify the new banned_at branch only.

async function countMarkupsByInternalUserId(internalId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT COUNT(*)::int AS n FROM markups WHERE internal_user_id = $1 AND deleted_at IS NULL`,
            [internalId]
        );
        return rows[0].n;
    } finally {
        await c.end();
    }
}

test('banned-user gate: banned user — POST /markup returns 201 but no Markup row created', async () => {
    const vid = '__e2e__banned_gate_blocked';
    const cat = cats.prv.intro;
    const userId = 'banned-gate-blocked-user';

    // Materialize the User row via a first POST /markup (this one must succeed
    // because banned_at starts as null).
    const base = { video_id: vid, v: '1', user_id: userId, category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });

    const internalId = await getAuthorInternalId(userId);
    assert.ok(internalId, 'pre: user has internal id');
    const baselineCount = await countMarkupsByInternalUserId(internalId);
    assert.equal(baselineCount, 1, `pre: baseline 1 markup, got ${baselineCount}`);

    // Set banned_at directly.
    await setUserBannedAt(internalId, new Date());
    const after = await selectUser(internalId);
    assert.ok(after.banned_at, 'pre: banned_at must be set');

    // POST /markup as the banned user → 201 (silent), but no new Markup row.
    const path = '/markup';
    const res = await request('POST', path, {
        ...base,
        data: { intervals: [{ start: 100, end: 110 }] },
    });
    assert.equal(res.status, 201, `banned user POST /markup must return 201, got ${res.status} ${JSON.stringify(res.body)}`);

    const finalCount = await countMarkupsByInternalUserId(internalId);
    assert.equal(finalCount, baselineCount,
        `banned user must NOT create a Markup row (expected ${baselineCount}, got ${finalCount})`);
});

test('banned-user gate: unbanned user — POST /markup creates Markup normally (regression)', async () => {
    const vid = '__e2e__banned_gate_unbanned';
    const cat = cats.prv.intro;
    const userId = 'banned-gate-unbanned-user';

    // Seed: one POST /markup to materialize the user row.
    const base = { video_id: vid, v: '1', user_id: userId, category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });

    const internalId = await getAuthorInternalId(userId);
    assert.ok(internalId, 'pre: user has internal id');

    // Confirm pre-conditions: banned_at null, rating above the rating gate.
    const before = await selectUser(internalId);
    assert.equal(before.banned_at, null, 'pre: banned_at must be null');
    assert.ok(before.rating > -2, `pre: rating must be > -2, got ${before.rating}`);

    const baselineCount = await countMarkupsByInternalUserId(internalId);

    // POST a second markup with a distinct interval.
    const path = '/markup';
    const res = await request('POST', path, {
        ...base,
        data: { intervals: [{ start: 200, end: 220 }] },
    });
    assert.equal(res.status, 201, `unbanned user POST /markup must return 201, got ${res.status} ${JSON.stringify(res.body)}`);

    // A new Markup row must exist (regression check).
    const finalCount = await countMarkupsByInternalUserId(internalId);
    assert.equal(finalCount, baselineCount + 1,
        `unbanned user must create a new Markup row (expected ${baselineCount + 1}, got ${finalCount})`);

    // And the interval is the expected one (sanity).
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows } = await c.query(
            `SELECT mti.start, mti."end"
             FROM markup_time_intervals mti
             JOIN markups m ON m.id = mti.markup_id
             WHERE m.internal_user_id = $1 AND m.deleted_at IS NULL
             ORDER BY mti.id DESC LIMIT 1`,
            [internalId]
        );
        assert.ok(rows[0], 'expected at least one interval row');
        assert.equal(rows[0].start, 200, `expected start=200, got ${rows[0].start}`);
        assert.equal(rows[0].end, 220, `expected end=220, got ${rows[0].end}`);
    } finally {
        await c.end();
    }
});

test('rating-gate: rating ≤ -2 user — POST /markup returns 201 but no Markup row created (regression)', async () => {
    // The original soft-rejection gate (prv/routes/markups.js IGNORE_MARKUPS_USER_RATING_VAL = -2)
    // must keep working independently of the new banned_at gate. Only the new gate has direct
    // test coverage so far — this seals the original path.
    const vid = '__e2e__rating_gate_regression';
    const cat = cats.prv.intro;
    const userId = 'rating-gate-regression-user';

    // Materialize the User row via one successful POST (rating starts at 0).
    const base = { video_id: vid, v: '1', user_id: userId, category_id: cat, data: {} };
    await postMarkup('', { ...base, data: { intervals: [{ start: 0, end: 10 }] } });

    const internalId = await getAuthorInternalId(userId);
    assert.ok(internalId, 'pre: user has internal id');
    const baselineCount = await countMarkupsByInternalUserId(internalId);
    assert.equal(baselineCount, 1, 'pre: baseline 1 markup');

    // Set rating to -3 (≤ IGNORE_MARKUPS_USER_RATING_VAL = -2), banned_at null.
    await setUserRating(internalId, -3);
    const after = await selectUser(internalId);
    assert.equal(after.banned_at, null, 'pre: banned_at must be null (regression: rating-gate path only)');
    assert.equal(after.rating, -3, 'pre: rating must be -3');

    // POST /markup → 201 (silent), no new Markup row.
    const res = await request('POST', '/markup', {
        ...base,
        data: { intervals: [{ start: 100, end: 110 }] },
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status} ${JSON.stringify(res.body)}`);

    const finalCount = await countMarkupsByInternalUserId(internalId);
    assert.equal(finalCount, baselineCount, 'rating-gate must NOT create a new Markup row');
});

// ── POST /markup interval validation (lib/validate-intervals.js) ──────────────
// Invalid intervals are a 400 before anything is written; a valid markup and all
// its intervals are created in one transaction.

async function markupRowsByUser(prefix, userId) {
    const tp = prefix ? `${prefix}_` : '';
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const { rows: markups } = await c.query(
            `SELECT id FROM ${tp}markups WHERE user_id = $1 AND deleted_at IS NULL ORDER BY id`, [userId]);
        const { rows: intervals } = await c.query(
            `SELECT mti.markup_id, mti.start, mti."end"
             FROM ${tp}markup_time_intervals mti
             JOIN ${tp}markups m ON m.id = mti.markup_id
             WHERE m.user_id = $1 AND mti.deleted_at IS NULL
             ORDER BY mti.id`, [userId]);
        return { markups, intervals };
    } finally {
        await c.end();
    }
}

async function assertMarkupRejected(prefix, body, msgRe) {
    const path = prefix ? `/${prefix}/markup` : '/markup';
    const res = await request('POST', path, body);
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    const msgs = (res.body.errors || []).map(e => e.msg).join('; ');
    assert.match(msgs, msgRe);
    const rows = await markupRowsByUser(prefix, body.user_id);
    assert.equal(rows.markups.length, 0, 'a rejected markup must leave no Markup row');
    assert.equal(rows.intervals.length, 0, 'a rejected markup must leave no interval row');
}

test('markup validation: empty intervals → 400, no Markup row', async () => {
    await assertMarkupRejected('', {
        video_id: '__e2e__markup_val_empty', v: '1', user_id: 'markup-val-empty', category_id: cats.prv.intro,
        data: { intervals: [] },
    }, /data\.intervals must not be empty/);
});

test('markup validation: end <= start → 400, no Markup row', async () => {
    await assertMarkupRejected('', {
        video_id: '__e2e__markup_val_order', v: '1', user_id: 'markup-val-order', category_id: cats.prv.intro,
        data: { intervals: [{ start: 30, end: 30 }] },
    }, /data\.intervals\[0\]\.start must be less than end/);
});

test('markup validation: missing end → 400, no Markup row', async () => {
    // Before the validator this was a 201 that stored the interval with end = NaN.
    await assertMarkupRejected('', {
        video_id: '__e2e__markup_val_noend', v: '1', user_id: 'markup-val-noend', category_id: cats.prv.intro,
        data: { intervals: [{ start: 10, end: 20 }, { start: 40 }] },
    }, /data\.intervals\[1\]\.end must be a finite number/);
});

test('markup validation: valid markup → 201 with its rounded interval', async () => {
    const userId = 'markup-val-valid';
    await postMarkup('', {
        video_id: '__e2e__markup_val_valid', v: '1', user_id: userId, category_id: cats.prv.intro,
        data: { intervals: [{ start: 5.4, end: '30.6' }] },
    });
    const rows = await markupRowsByUser('', userId);
    assert.equal(rows.markups.length, 1);
    assert.deepEqual(rows.intervals.map(r => [r.start, r.end]), [[5, 31]]);
});

test('markup validation: valid 2-interval markup creates one Markup row and both intervals', async () => {
    const userId = 'markup-val-two';
    await postMarkup('', {
        video_id: '__e2e__markup_val_two', v: '1', user_id: userId, category_id: cats.prv.intro,
        data: { intervals: [{ start: 0, end: 10 }, { start: 100, end: 130 }] },
    });
    const rows = await markupRowsByUser('', userId);
    assert.equal(rows.markups.length, 1);
    assert.deepEqual(rows.intervals.map(r => [r.markup_id, r.start, r.end]),
        [[rows.markups[0].id, 0, 10], [rows.markups[0].id, 100, 130]]);
});

test('markup validation: rt uses the shared validator (21 intervals → 400, missing end → 400)', async () => {
    const base = { video_id: '__e2e__markup_val_rt', v: '1', user_id: 'markup-val-rt', category_id: cats.rt.intro, duration: 300 };
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ start: i * 10, end: i * 10 + 5 }));
    await assertMarkupRejected('rt', { ...base, data: { intervals: tooMany } }, /at most 20 items/);
    await assertMarkupRejected('rt', { ...base, data: { intervals: [{ start: 10 }] } }, /data\.intervals\[0\]\.end must be a finite number/);
});

// ── PUT /markups interval validation ─────────────────────────────────────────
// The edited interval (new values merged with the stored ones) must obey the same
// rules; a rejected edit leaves the interval and is_new untouched. The valid edit
// writes the interval and is_new = true in one transaction.

async function putMarkup(prefix, body) {
    return request('PUT', prefix ? `/${prefix}/markups` : '/markups', body);
}

async function seedForPut(prefix, vid, userId, catId, extra = {}) {
    await postMarkup(prefix, { video_id: vid, v: '1', user_id: userId, category_id: catId, ...extra,
        data: { intervals: [{ start: 100, end: 130 }] } });
    runCalc(prefix || 'prv'); // is_new → false, so the edit's is_new = true is observable
    const rows = await markupRowsByUser(prefix, userId);
    assert.deepEqual(rows.intervals.map(r => [r.start, r.end]), [[100, 130]]);
    return { video_id: vid, user_id: userId, category_id: catId, start: 100, end: 130, ...extra };
}

async function isNewByUser(prefix, userId) {
    const tp = prefix ? `${prefix}_` : '';
    const rows = await dbQuery(`SELECT is_new FROM ${tp}markups WHERE user_id = $1 AND deleted_at IS NULL`, [userId]);
    return rows.map(r => r.is_new);
}

test('PUT /markups: new_start above the stored end → 400, interval and is_new unchanged', async () => {
    const userId = 'put-markup-start';
    const body = await seedForPut('', '__e2e__put_markup_start', userId, cats.prv.intro);
    const res = await putMarkup('', { ...body, new_start: 130 });
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body, /start must be less than end/);
    const rows = await markupRowsByUser('', userId);
    assert.deepEqual(rows.intervals.map(r => [r.start, r.end]), [[100, 130]]);
    assert.deepEqual(await isNewByUser('', userId), [false]);
});

test('PUT /markups: new_end above 86400 → 400, interval unchanged', async () => {
    const userId = 'put-markup-end';
    const body = await seedForPut('', '__e2e__put_markup_end', userId, cats.prv.intro);
    const res = await putMarkup('', { ...body, new_end: 86401 });
    assert.equal(res.status, 400, `expected 400, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.match(res.body, /end must be <= 86400/);
    const rows = await markupRowsByUser('', userId);
    assert.deepEqual(rows.intervals.map(r => [r.start, r.end]), [[100, 130]]);
});

test('PUT /markups: a valid edit → 200, the interval and is_new = true are stored', async () => {
    const userId = 'put-markup-valid';
    const body = await seedForPut('', '__e2e__put_markup_valid', userId, cats.prv.intro);
    const res = await putMarkup('', { ...body, new_start: 90, new_end: 140 });
    assert.equal(res.status, 200, `expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
    const rows = await markupRowsByUser('', userId);
    assert.deepEqual(rows.intervals.map(r => [r.start, r.end]), [[90, 140]]);
    assert.deepEqual(await isNewByUser('', userId), [true]);
});

test('PUT /markups: rt and yt reject new_end <= start with 400', async () => {
    const rt = await seedForPut('rt', '__e2e__put_markup_rt', 'put-markup-rt', cats.rt.intro, { duration: 300 });
    const resRt = await putMarkup('rt', { ...rt, new_end: 100 });
    assert.equal(resRt.status, 400, `rt: expected 400, got ${resRt.status} ${JSON.stringify(resRt.body)}`);
    assert.deepEqual((await markupRowsByUser('rt', 'put-markup-rt')).intervals.map(r => [r.start, r.end]), [[100, 130]]);

    const yt = await seedForPut('yt', '__e2e__put_markup_yt', 'put-markup-yt', cats.yt.intro, { duration: 300 });
    const resYt = await putMarkup('yt', { ...yt, new_start: 0, new_end: 0 });
    assert.equal(resYt.status, 400, `yt: expected 400, got ${resYt.status} ${JSON.stringify(resYt.body)}`);
    assert.deepEqual((await markupRowsByUser('yt', 'put-markup-yt')).intervals.map(r => [r.start, r.end]), [[100, 130]]);
});

// ── /admin/user/:internal_id (video-less user view) tests ─────────────────────
// Route param is INTERNAL users.id (PK), not prv_user_id — prv_user_id is not
// unique across User rows (unique index is composite (generated_user_id,
// prv_user_id)), so prv_user_id alone is ambiguous.

async function setUserPrvId(internalId, prvUserId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query(`UPDATE users SET prv_user_id = $1 WHERE id = $2`, [prvUserId, internalId]);
    } finally {
        await c.end();
    }
}

test('GET /admin/user/:internal_id renders and contains expected markup IDs', async () => {
    const prvUserId = 12345;
    const userId = 'admin-user-view-user';
    const cat = cats.prv.intro;

    // Seed 3 markups across 2 different videos.
    const vidA = '__e2e__admin_user_view_a';
    const vidB = '__e2e__admin_user_view_b';
    const base = { v: '1', user_id: userId, category_id: cat, data: {} };
    await postMarkup('', { ...base, video_id: vidA, data: { intervals: [{ start: 0, end: 10 }] } });
    await postMarkup('', { ...base, video_id: vidA, data: { intervals: [{ start: 30, end: 40 }] } });
    await postMarkup('', { ...base, video_id: vidB, data: { intervals: [{ start: 5, end: 15 }] } });

    // Force the seeded user's prv_user_id so the page surfaces it for display.
    // The route param is the internal id (returned by getAuthorInternalId).
    const internalId = await getAuthorInternalId(userId);
    assert.ok(internalId, 'pre: user must have internal id');
    await setUserPrvId(internalId, prvUserId);

    const path = `/admin/user/${internalId}?verifyBearerToken=${encodeURIComponent(MOD_AUTH)}`;
    const res = await request('GET', path, null);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    assert.ok(typeof res.body === 'string', 'body must be HTML string');

    // Pull the actual markup ids for this user so we can assert presence.
    const c = adminClient(TEST_DB);
    await c.connect();
    let markupIds;
    try {
        const r = await c.query(
            `SELECT id FROM markups WHERE internal_user_id = $1 ORDER BY id ASC`,
            [internalId]
        );
        markupIds = r.rows.map(row => row.id);
    } finally {
        await c.end();
    }
    assert.equal(markupIds.length, 3, `expected 3 markup ids for the user, got ${markupIds.length}`);

    // Body must contain each markup id and both video native_ids.
    for (const id of markupIds) {
        assert.ok(res.body.includes(String(id)), `body missing markup id ${id}`);
    }
    assert.ok(res.body.includes(vidA), `body missing video native_id ${vidA}`);
    assert.ok(res.body.includes(vidB), `body missing video native_id ${vidB}`);
    // prv_user_id is displayed in the header for human recognizability.
    assert.ok(res.body.includes(String(prvUserId)), 'body must mention the prv_user_id');
});

test('GET /admin/user/:internal_id without token returns 401', async () => {
    const res = await request('GET', '/admin/user/12345', null);
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);
});

test('GET /admin/user/:internal_id unknown internal_id returns 404', async () => {
    const path = `/admin/user/99999999?verifyBearerToken=${encodeURIComponent(MOD_AUTH)}`;
    const res = await request('GET', path, null);
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

// ── Review sheet importer (scripts/import-review-sheet.js) ───────────────────

// Copy the fixture sheet into a temp dir (the importer writes a .bak next to
// the md) and return the md path there. The dirs are removed after the run.
const reviewTmpDirs = [];
after(() => {
    for (const dir of reviewTmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function copyReviewFixture(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-import-'));
    reviewTmpDirs.push(dir);
    const md = path.join(dir, `${name}.md`);
    fs.copyFileSync(path.join(APP_DIR, 'test/fixtures/review-sheet.md'), md);
    fs.copyFileSync(path.join(APP_DIR, 'test/fixtures/review-sheet.key.tsv'), path.join(dir, `${name}.key.tsv`));
    return md;
}

function runImport(mdPath, extraArgs = []) {
    const r = spawnSync('node', ['scripts/import-review-sheet.js', mdPath, ...extraArgs], {
        cwd: APP_DIR,
        env: { ...process.env, DB_NAME: TEST_DB, DB_HOST, DB_PORT: String(DB_PORT) },
        encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function setVerdictLine(mdPath, itemCode, verdict) {
    const lines = fs.readFileSync(mdPath, 'utf8').split('\n');
    let inItem = false;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('###')) inItem = lines[i].startsWith(`### ${itemCode}.`);
        else if (inItem && lines[i].startsWith('Verdict:')) lines[i] = `Verdict: ${verdict}`;
    }
    fs.writeFileSync(mdPath, lines.join('\n'));
}

async function reviewState(batch) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        const items = (await c.query(
            `SELECT id, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by
               FROM prv_review_items WHERE batch = $1 ORDER BY position`, [batch])).rows;
        const verdicts = (await c.query(
            `SELECT i.item_code, v.verdict, v.comment, v.reviewer, v.source
               FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id
              WHERE i.batch = $1 ORDER BY i.position, v.decided_at, v.id`, [batch])).rows;
        return { items, verdicts };
    } finally {
        await c.end();
    }
}

// Batch progress row as the repository and the JSON return it (3 items).
function batchRow(batch, { decided, finished = [], locked_by = null, state = 'available', reviews_needed = 1 }) {
    return { batch, total: 3, decided, open: 3 - decided, reviews_needed, finished, locked_by, locked_at: null, state };
}

// Raw-SQL items need their batch row, as the importer writes it.
function insertBatchRow(c, batch) {
    return c.query('INSERT INTO prv_review_batches (batch) VALUES ($1) ON CONFLICT DO NOTHING', [batch]);
}

test('review import: items and md verdicts imported, md untouched, backup written', async () => {
    const batch = 'e2e-review-import-basic';
    const md = copyReviewFixture(batch);
    const before = fs.readFileSync(md, 'utf8');

    const r = runImport(md);
    assert.equal(r.status, 0, `import failed: ${r.stderr}`);
    assert.match(r.stdout, /items inserted: 3/);
    assert.match(r.stdout, /verdicts imported: 2/);
    assert.match(r.stdout, /C2 sponsor/);
    assert.match(r.stdout, /C5 not_ad \(with comment\)/);

    assert.equal(fs.readFileSync(md, 'utf8'), before, 'md must not be modified');
    const backups = fs.readdirSync(path.dirname(md)).filter(f => /\.md\.bak-\d{14}(-\d+)?$/.test(f));
    assert.equal(backups.length, 1, `expected one backup, got ${backups}`);
    assert.equal(fs.readFileSync(path.join(path.dirname(md), backups[0]), 'utf8'), before);

    const { items, verdicts } = await reviewState(batch);
    assert.deepEqual(items.map(i => i.item_code), ['C2', 'C5', 'C7']);
    const c2 = items[0];
    assert.equal(c2.native_id, '-1_456000901');
    assert.equal(c2.start, 262.4);
    assert.equal(c2.end, 269.2);
    assert.equal(c2.proposed, 'sponsor');
    assert.equal(c2.link, 'https://example.invalid/video-1_456000901?t=4m20s');
    assert.deepEqual(c2.flagged_by, ['2026-10-14-claude-sonnet-5-5-v2.1-batch-nt-think']);

    assert.equal(verdicts.length, 2);
    assert.deepEqual(verdicts.map(v => [v.item_code, v.verdict, v.reviewer, v.source]),
        [['C2', 'sponsor', 'bayanovea', 'import'], ['C5', 'not_ad', 'bayanovea', 'import']]);
    assert.equal(verdicts[0].comment, null);
    assert.ok(verdicts[1].comment.startsWith('Просьба покомментить есть'));
    assert.equal(verdicts[1].comment.split('\n').length, 2, 'multi-line comment kept as two lines');
});

test('review import: re-import does not duplicate items or verdicts; later page verdict wins over md', async () => {
    const batch = 'e2e-review-import-rerun';
    const md = copyReviewFixture(batch);
    assert.equal(runImport(md).status, 0);

    // Second run, md unchanged: nothing new.
    const r2 = runImport(md);
    assert.equal(r2.status, 0, `re-import failed: ${r2.stderr}`);
    assert.match(r2.stdout, /items inserted: 0/);
    assert.match(r2.stdout, /items already present: 3/);
    assert.match(r2.stdout, /verdicts imported: 0/);
    assert.match(r2.stdout, /verdicts skipped, item already has one: 2 \(C2, C5\)/);
    let st = await reviewState(batch);
    assert.equal(st.items.length, 3);
    assert.equal(st.verdicts.length, 2);

    // More md marking: C7 gets a verdict → only that one is added.
    setVerdictLine(md, 'C7', 'Unclear');
    const r3 = runImport(md);
    assert.equal(r3.status, 0, `re-import failed: ${r3.stderr}`);
    assert.match(r3.stdout, /verdicts imported: 1\n {2}C7 unclear/);
    st = await reviewState(batch);
    assert.equal(st.verdicts.length, 3);
    assert.deepEqual(st.verdicts.find(v => v.item_code === 'C7'),
        { item_code: 'C7', verdict: 'unclear', comment: null, reviewer: 'bayanovea', source: 'import' });

    // A page verdict on C2, then the md changes C2: re-import must not touch it.
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query(
            `INSERT INTO prv_review_verdicts (item_id, verdict, comment, reviewer, source, decided_at)
             VALUES ($1, 'self_promotion', 'changed my mind', 'assessor', 'page', NOW())`,
            [st.items.find(i => i.item_code === 'C2').id]);
    } finally {
        await c.end();
    }
    setVerdictLine(md, 'C2', 'not an ad');
    const r4 = runImport(md);
    assert.equal(r4.status, 0, `re-import failed: ${r4.stderr}`);
    assert.match(r4.stdout, /verdicts imported: 0/);
    st = await reviewState(batch);
    assert.equal(st.items.length, 3);
    const c2 = st.verdicts.filter(v => v.item_code === 'C2');
    assert.deepEqual(c2.map(v => [v.verdict, v.source]), [['sponsor', 'import'], ['self_promotion', 'page']]);

    const backups = fs.readdirSync(path.dirname(md)).filter(f => f.includes('.md.bak-'));
    assert.equal(backups.length, 4, 'one backup per run, none overwritten');
});

test('review import: --batch overrides the name; unknown verdict fails and writes nothing', async () => {
    const md = copyReviewFixture('e2e-review-sheet-file');
    const ok = runImport(md, ['--batch', 'e2e-review-import-named']);
    assert.equal(ok.status, 0, `import failed: ${ok.stderr}`);
    assert.equal((await reviewState('e2e-review-import-named')).items.length, 3);
    assert.equal((await reviewState('e2e-review-sheet-file')).items.length, 0);

    const bad = copyReviewFixture('e2e-review-import-bad');
    setVerdictLine(bad, 'C7', 'maybe');
    const r = runImport(bad);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /C7: unknown verdict "maybe"/);
    const st = await reviewState('e2e-review-import-bad');
    assert.equal(st.items.length, 0);
    assert.equal(st.verdicts.length, 0);
});

test('review import: verdict typed on the line after an empty "Verdict:" is imported', async () => {
    const batch = 'e2e-review-import-next-line';
    const md = copyReviewFixture(batch);
    const withNextLine = (text) => fs.readFileSync(md, 'utf8').replace(/(### C7\.[\s\S]*?Verdict:) ?\n/, `$1 \n${text}\n`);
    fs.writeFileSync(md, withNextLine('not an ad\nПросто шутка ведущего'));
    const r = runImport(md);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /verdicts imported: 3/);
    assert.deepEqual((await reviewState(batch)).verdicts.find(v => v.item_code === 'C7'),
        { item_code: 'C7', verdict: 'not_ad', comment: 'Просто шутка ведущего', reviewer: 'bayanovea', source: 'import' });

    // Text after an empty Verdict: that is not a verdict fails the import, never silently dropped.
    const bad = copyReviewFixture('e2e-review-import-next-line-bad');
    fs.writeFileSync(bad, fs.readFileSync(bad, 'utf8').replace(/(### C7\.[\s\S]*?Verdict:) ?\n/, '$1 \nпросто шутка\n'));
    const rb = runImport(bad);
    assert.equal(rb.status, 1);
    assert.match(rb.stderr, /C7: empty "Verdict:" line and "просто шутка" after it is not a verdict/);
    const st = await reviewState('e2e-review-import-next-line-bad');
    assert.equal(st.items.length, 0);
    assert.equal(st.verdicts.length, 0);
});

test('review import: a DB error on a later item rolls back the whole import', async () => {
    const batch = 'e2e-review-import-rollback';
    const md = copyReviewFixture(batch);
    // C7 is the last item: C2 and C5 are inserted before its proposed value
    // overflows VARCHAR(64) inside the transaction.
    fs.writeFileSync(md, fs.readFileSync(md, 'utf8').replace(
        /(### C7\.[\s\S]*?)Proposed as: self_promotion/, `$1Proposed as: ${'x'.repeat(70)}`));
    const r = runImport(md);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /import failed/);
    const st = await reviewState(batch);
    assert.equal(st.items.length, 0, 'C2 and C5 rolled back too');
    assert.equal(st.verdicts.length, 0);
});

test('review import: re-import with a different stretch under an existing code fails and writes nothing', async () => {
    const batch = 'e2e-review-import-mismatch';
    const md = copyReviewFixture(batch);
    assert.equal(runImport(md).status, 0);

    // Sheet regenerated under the same name: C7 is now another stretch and
    // already carries a verdict in the md.
    const keyPath = md.replace(/\.md$/, '.key.tsv');
    fs.writeFileSync(keyPath, fs.readFileSync(keyPath, 'utf8').replace(/^(C7\t[^\t]+\t)62\.2/m, '$150.0'));
    setVerdictLine(md, 'C7', 'sponsor');
    const r = runImport(md);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /C7: batch e2e-review-import-mismatch already has a different item under this code \(start 62\.2 ≠ 50\)/);
    const st = await reviewState(batch);
    assert.equal(st.items.find(i => i.item_code === 'C7').start, 62.2, 'existing item untouched');
    assert.deepEqual(st.verdicts.map(v => v.item_code), ['C2', 'C5'], 'no verdict for the changed item');
});

test('review import: works on review tables created without timestamp defaults; sync-db.js adds them', async () => {
    // The local dump's review tables were created by sync() from the first
    // model (JS-only DataTypes.NOW): created_at / decided_at NOT NULL with no
    // DB default. Reproduce that DDL in a separate DB.
    const db = `${TEST_DB}_oldschema`;
    const env = { ...process.env, DB_NAME: db, DB_HOST, DB_PORT: String(DB_PORT) };
    const admin = adminClient();
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
    await admin.query(`CREATE DATABASE "${db}"`);
    const c = adminClient(db);
    let connected = false;
    try {
        const sync = () => spawnSync('node', ['scripts/sync-db.js'], { cwd: APP_DIR, env, encoding: 'utf8' });
        let r = sync();
        assert.equal(r.status, 0, `sync-db failed: ${r.stderr}`);
        await c.connect();
        connected = true;
        await c.query('ALTER TABLE prv_review_items ALTER COLUMN created_at DROP DEFAULT');
        await c.query('ALTER TABLE prv_review_verdicts ALTER COLUMN decided_at DROP DEFAULT');
        const defaults = async () => (await c.query(
            `SELECT table_name, column_default FROM information_schema.columns
              WHERE (table_name, column_name) IN (('prv_review_items', 'created_at'), ('prv_review_verdicts', 'decided_at'))
              ORDER BY table_name`)).rows.map(row => [row.table_name, row.column_default]);
        assert.deepEqual(await defaults(), [['prv_review_items', null], ['prv_review_verdicts', null]]);

        const md = copyReviewFixture('e2e-review-import-oldschema');
        const importOld = () => spawnSync('node', ['scripts/import-review-sheet.js', md],
            { cwd: APP_DIR, env, encoding: 'utf8' });
        r = importOld();
        assert.equal(r.status, 0, `import on old schema failed: ${r.stderr}`);
        assert.match(r.stdout, /items inserted: 3/);
        assert.match(r.stdout, /verdicts imported: 2/);
        // Re-import: NOT NULL is checked before ON CONFLICT DO NOTHING.
        r = importOld();
        assert.equal(r.status, 0, `re-import on old schema failed: ${r.stderr}`);
        assert.match(r.stdout, /items already present: 3/);
        const { rows } = await c.query(
            `SELECT (SELECT COUNT(*)::int FROM prv_review_items WHERE created_at IS NOT NULL) AS items,
                    (SELECT COUNT(*)::int FROM prv_review_verdicts WHERE decided_at IS NOT NULL) AS verdicts`);
        assert.deepEqual(rows[0], { items: 3, verdicts: 2 });

        // sync-db.js on the existing tables: same ALTERs as app boot.
        r = sync();
        assert.equal(r.status, 0, `sync-db failed: ${r.stderr}`);
        assert.deepEqual(await defaults(),
            [['prv_review_items', 'CURRENT_TIMESTAMP'], ['prv_review_verdicts', 'CURRENT_TIMESTAMP']]);
    } finally {
        if (connected) await c.end();
        await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
        await admin.end();
    }
});

test('schema one-off: batch assignee → exclusions and locks, column dropped; a second boot changes nothing', async () => {
    const db = `${TEST_DB}_assignee`;
    const env = { ...process.env, DB_NAME: db, DB_HOST, DB_PORT: String(DB_PORT) };
    const sync = () => spawnSync('node', ['scripts/sync-db.js'], { cwd: APP_DIR, env, encoding: 'utf8' });
    const admin = adminClient();
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
    await admin.query(`CREATE DATABASE "${db}"`);
    const c = adminClient(db);
    let connected = false;
    try {
        let r = sync();
        assert.equal(r.status, 0, `sync-db failed: ${r.stderr}`);
        await c.connect();
        connected = true;
        // The pre-lock shape: assignee, none of the lock columns.
        await c.query(`ALTER TABLE prv_review_batches
            DROP COLUMN reviews_needed, DROP COLUMN excluded, DROP COLUMN locked_by, DROP COLUMN locked_at,
            ADD COLUMN assignee VARCHAR(64)`);
        // [batch, assignee (undefined = no batch row), verdicts by reviewer]; every batch has items C1, C2.
        const seed = [
            ['g-started', 'gkshi', { gkshi: ['C1'] }],
            ['g-untouched', 'gkshi', {}],
            ['g-finished', 'gkshi', { gkshi: ['C1', 'C2'] }],
            ['b-partial', 'bayanovea', { owner: ['C1'] }],                  // pre-reviewer verdict, renamed first
            ['b-finished', 'bayanovea', { bayanovea: ['C1'], owner: ['C2'] }],
            ['b-untouched', 'bayanovea', {}],
            ['anyone', null, { gkshi: ['C1'] }],
            ['no-row', undefined, {}],
        ];
        for (const [batch, assignee, verdicts] of seed) {
            if (assignee !== undefined) await c.query('INSERT INTO prv_review_batches (batch, assignee) VALUES ($1, $2)', [batch, assignee]);
            const ids = {};
            for (const [pos, code] of ['C1', 'C2'].entries()) {
                ids[code] = (await c.query(
                    `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed)
                     VALUES ($1, $2, $3, '-1_1', 10, 20, 'sponsor') RETURNING id`, [batch, code, pos + 1])).rows[0].id;
            }
            for (const [reviewer, codes] of Object.entries(verdicts)) {
                for (const code of codes) {
                    await c.query(`INSERT INTO prv_review_verdicts (item_id, verdict, reviewer, source) VALUES ($1, 'sponsor', $2, 'import')`,
                        [ids[code], reviewer]);
                }
            }
        }

        r = sync();
        assert.equal(r.status, 0, `sync-db failed: ${r.stderr}`);
        const columns = (await c.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'prv_review_batches' ORDER BY column_name`)).rows
            .map(row => row.column_name);
        assert.deepEqual(columns, ['batch', 'created_at', 'excluded', 'locked_at', 'locked_by', 'reviews_needed']);
        const batches = async () => (await c.query(
            'SELECT batch, reviews_needed, excluded, locked_by, locked_at FROM prv_review_batches ORDER BY batch')).rows;
        const after = await batches();
        assert.deepEqual(after.map(b => [b.batch, b.reviews_needed, b.excluded, b.locked_by, b.locked_at != null]), [
            ['anyone', 1, [], null, false],
            ['b-finished', 1, [], null, false],
            ['b-partial', 1, [], 'bayanovea', true],
            ['b-untouched', 1, [], 'bayanovea', true],
            ['g-finished', 1, ['bayanovea'], null, false],
            ['g-started', 1, ['bayanovea'], 'gkshi', true],
            ['g-untouched', 1, ['bayanovea'], null, false],
            ['no-row', 1, [], null, false],
        ]);

        r = sync();
        assert.equal(r.status, 0, `sync-db failed: ${r.stderr}`);
        assert.deepEqual(await batches(), after, 'second boot is a no-op');
    } finally {
        if (connected) await c.end();
        await admin.query(`DROP DATABASE IF EXISTS "${db}"`);
        await admin.end();
    }
});

// ── Review repository (prv/repository/review.js) ──────────────────────────────

// The repository is exercised in-process against the e2e DB (no route yet).
async function withReviewRepo(fn) {
    const sequelize = new Sequelize(TEST_DB, DB_USER, DB_PASSWORD, {
        host: DB_HOST, port: DB_PORT, dialect: 'postgres', logging: false,
    });
    try {
        return await fn(createReviewRepository(definePrvModels(sequelize), sequelize), sequelize);
    } finally {
        await sequelize.close();
    }
}

test('review repository: getSignals collects live markups, segments + votes, undos and clicks around the stretch', async () => {
    const nid = '__e2e__review_signals';
    const other = '__e2e__review_signals_other';
    const sponsor = cats.prv.sponsor;
    const c = adminClient(TEST_DB);
    await c.connect();
    const ids = {};
    try {
        const one = async (sql, params) => (await c.query(sql, params)).rows[0];
        // Two videos rows for one native_id (duration split) + an unrelated video.
        const v1 = (await one(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt") VALUES ($1, 600, NOW(), NOW()) RETURNING id`, [nid])).id;
        const v2 = (await one(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt") VALUES ($1, 603, NOW(), NOW()) RETURNING id`, [nid])).id;
        const v3 = (await one(`INSERT INTO videos (native_id, "createdAt", "updatedAt") VALUES ($1, NOW(), NOW()) RETURNING id`, [other])).id;
        ids.author = (await one(
            `INSERT INTO users (generated_user_id, rating, "createdAt", "updatedAt") VALUES ($1, 7, NOW(), NOW()) RETURNING id`,
            ['e2e-review-signals-author'])).id;
        ids.banned = (await one(
            `INSERT INTO users (generated_user_id, rating, banned_at, "createdAt", "updatedAt") VALUES ($1, -150, NOW(), NOW(), NOW()) RETURNING id`,
            ['e2e-review-signals-banned'])).id;
        const markup = async (key, video, start, end, { markupDeleted = false, intervalDeleted = false, author = ids.author } = {}) => {
            const m = await one(
                `INSERT INTO markups (video_id, user_id, internal_user_id, category_id, is_new, deleted_at, "createdAt", "updatedAt")
                 VALUES ($1, 'e2e-review-signals-author', $2, $3, false, $4, NOW(), NOW()) RETURNING id`,
                [video, author, sponsor, markupDeleted ? new Date() : null]);
            await c.query(
                `INSERT INTO markup_time_intervals (markup_id, start, "end", deleted_at, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, $4, NOW(), NOW())`,
                [m.id, start, end, intervalDeleted ? new Date() : null]);
            ids[key] = m.id;
        };
        // Stretch 100–120 s, window 30 → 70–150.
        await markup('inA', v1, 140, 160);                       // overlaps the window end
        await markup('inB', v2, 60, 75, { author: ids.banned }); // other videos row, overlaps the start
        await markup('edgeLo', v1, 50, 70);                      // ends exactly at the window start
        await markup('edgeHi', v1, 150, 170);                    // starts exactly at the window end
        await markup('justOut', v1, 50, 69.9);                   // ends just before the window
        await markup('deletedMarkup', v1, 100, 110, { markupDeleted: true });
        await markup('deletedInterval', v1, 100, 110, { intervalDeleted: true });
        await markup('outside', v1, 200, 220);
        await markup('otherVideo', v3, 100, 110);

        const seg = async (video, start, end, rating) => (await one(
            `INSERT INTO prv_calculated_segments (video_id, category_id, start, "end", rating, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id`, [video, sponsor, start, end, rating])).id;
        ids.segIn = await seg(v1, 101, 119, 1);
        ids.segOut = await seg(v1, 300, 310, 0);
        // Votes match by (video, category, start, end): the intro vote with the
        // same times belongs to another segment and must not be counted.
        for (const [i, [vote, category]] of [[1, sponsor], [1, sponsor], [-1, sponsor], [-1, cats.prv.intro]].entries()) {
            await c.query(
                `INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, 101, 119, $4, NOW(), NOW())`, [`e2e-review-voter-${i}`, v1, category, vote]);
        }

        for (const table of ['prv_events_interval_undo', 'prv_events_interval_click']) {
            const extraCol = table.endsWith('click') ? ', click_time' : '';
            const extraVal = table.endsWith('click') ? ', 105' : '';
            for (const [native, start, end] of [[nid, 95, 118], [nid, 400, 410], [other, 95, 118]]) {
                await c.query(
                    `INSERT INTO ${table} (user_id, video_native_id, category_id, start, "end"${extraCol}, "createdAt", "updatedAt")
                     VALUES ('e2e-review-signals', $1, $2, $3, $4${extraVal}, NOW(), NOW())`,
                    [native, sponsor, start, end]);
            }
        }
    } finally {
        await c.end();
    }

    const s = await withReviewRepo(repo => repo.getSignals(nid, 100, 120));
    assert.deepEqual(s.window, { start: 70, end: 150 });
    assert.equal(s.videos.length, 2, 'both videos rows for the native_id');
    assert.deepEqual(s.markups.map(m => m.markup_id), [ids.edgeLo, ids.inB, ids.inA, ids.edgeHi],
        'only live, in-window markups of this native_id (bounds inclusive), ordered by start');
    const a = s.markups.find(m => m.markup_id === ids.inA);
    assert.equal(a.category, 'sponsor');
    assert.equal(a.start, 140);
    assert.equal(a.end, 160);
    assert.equal(a.author_rating, 7);
    assert.equal(a.author_banned, false);
    assert.equal(a.user_id, ids.author);
    const b = s.markups.find(m => m.markup_id === ids.inB);
    assert.deepEqual([b.user_id, b.author_rating, b.author_banned], [ids.banned, -150, true]);

    assert.deepEqual(s.segments.map(x => x.segment_id), [ids.segIn]);
    assert.deepEqual(
        { rating: s.segments[0].rating, likes: s.segments[0].likes, dislikes: s.segments[0].dislikes, category: s.segments[0].category },
        { rating: 1, likes: 2, dislikes: 1, category: 'sponsor' });
    assert.equal(s.undos, 1);
    assert.equal(s.clicks, 1);

    const none = await withReviewRepo(repo => repo.getSignals('__e2e__review_no_video', 100, 120));
    assert.deepEqual(none, { window: { start: 70, end: 150 }, videos: [], markups: [], segments: [], undos: 0, clicks: 0 });
    const early = await withReviewRepo(repo => repo.getSignals('__e2e__review_no_video', 10, 20));
    assert.deepEqual(early.window, { start: 0, end: 50 }, 'window start clamped at 0');
});

test('review repository: latest verdict wins, history kept, blind until decided, navigation helpers', async () => {
    const batch = 'e2e-review-repo';
    assert.equal(runImport(copyReviewFixture(batch)).status, 0);   // C2 sponsor, C5 not_ad, C7 open

    await withReviewRepo(async (repo, sequelize) => {
        const open = await repo.getItem(batch, 'C7');
        assert.equal(open.verdict, null);
        assert.deepEqual(open.history, []);
        assert.ok(!('flagged_by' in open), 'flagged_by hidden before a verdict');
        assert.deepEqual(await repo.firstOpenItem(batch, 'bayanovea'), { item_code: 'C7', decided: false, link: 'https://example.invalid/video-1_456000903?t=1m0s' });
        assert.equal((await repo.defaultItem(batch, 'bayanovea')).item_code, 'C7');
        assert.equal((await repo.defaultItem(batch, 'gkshi')).item_code, 'C2', 'open = not decided by this reviewer');
        assert.deepEqual(await repo.nextOpenItem(batch, 2, 'bayanovea'), { item_code: 'C7', decided: false, link: 'https://example.invalid/video-1_456000903?t=1m0s' });
        assert.deepEqual(await repo.nextOpenItem(batch, 7, 'bayanovea'), { item_code: 'C7', decided: false, link: 'https://example.invalid/video-1_456000903?t=1m0s' }, 'wraps round to the first open item');
        assert.deepEqual(await repo.getBatchProgress(batch, 'bayanovea'), batchRow(batch, { decided: 2 }));
        const listed = (await repo.listBatches({ reviewer: 'bayanovea' })).find(b => b.batch === batch);
        assert.deepEqual(listed, batchRow(batch, { decided: 2 }));
        assert.deepEqual(await repo.getBatchProgress(batch, 'gkshi'), batchRow(batch, { decided: 0 }), 'decided counts the reviewer\'s own verdicts');

        assert.deepEqual(await repo.neighbours(batch, 5, 'bayanovea'),
            { prev: { item_code: 'C2', decided: true, link: 'https://example.invalid/video-1_456000901?t=4m20s' }, next: { item_code: 'C7', decided: false, link: 'https://example.invalid/video-1_456000903?t=1m0s' } });
        assert.equal((await repo.neighbours(batch, 5, 'gkshi')).prev.decided, false, 'decided by this reviewer');
        assert.equal((await repo.neighbours(batch, 2, 'bayanovea')).prev, null);

        // Bad input never writes a row.
        const inputError = (re) => (e) => e instanceof ReviewInputError && re.test(e.message);
        await assert.rejects(repo.recordVerdict({ item_id: open.id, verdict: 'maybe', reviewer: 'bayanovea', source: 'page' }),
            inputError(/verdict must be one of/));
        await assert.rejects(repo.recordVerdict({ item_id: 99999999, verdict: 'sponsor', reviewer: 'bayanovea', source: 'page' }),
            inputError(/unknown review item/));
        await assert.rejects(repo.recordVerdict({ item_id: 2147483648, verdict: 'sponsor', reviewer: 'bayanovea', source: 'page' }),
            inputError(/item_id must be a positive integer/), 'beyond INTEGER → input error, not a DB error');
        await assert.rejects(repo.recordVerdict({ item_id: open.id, verdict: 'sponsor', reviewer: '  ', source: 'page' }),
            inputError(/reviewer/));
        await assert.rejects(repo.recordVerdict({ item_id: open.id, verdict: 'sponsor', reviewer: 'owner', source: 'page' }),
            inputError(/unknown reviewer owner/), 'reviewer must be registered');
        assert.deepEqual(await repo.listReviewers(), ['bayanovea', 'gkshi']);
        assert.equal(await repo.isReviewer('gkshi'), true);
        assert.equal(await repo.isReviewer(''), false);
        await assert.rejects(repo.recordVerdict({ item_id: open.id, verdict: 'sponsor', reviewer: 'owner', source: 'api' }),
            (e) => !(e instanceof ReviewInputError) && /bad source/.test(e.message), 'source is a caller bug, not input');
        assert.equal(await repo.getItemById(2147483648), null);
        assert.equal((await repo.getItem(batch, 'C7')).history.length, 0);

        await repo.recordVerdict({ item_id: open.id, verdict: 'sponsor', comment: '   ', reviewer: 'bayanovea', source: 'page' });
        await repo.recordVerdict({ item_id: open.id, verdict: 'not_ad', comment: ' just a plug\n', reviewer: ' gkshi ', source: 'page' });

        const decided = await repo.getItem(batch, 'C7');
        assert.equal(decided.verdict.verdict, 'not_ad', 'latest verdict wins');
        assert.equal(decided.verdict.comment, 'just a plug');
        assert.equal(decided.verdict.reviewer, 'gkshi');
        assert.deepEqual(decided.history.map(h => [h.verdict, h.comment, h.source]),
            [['not_ad', 'just a plug', 'page'], ['sponsor', null, 'page']]);
        assert.deepEqual(decided.flagged_by, ['2026-10-14-claude-sonnet-5-5-v2.1-batch-nt-think'],
            'flagged_by shown once decided');

        // decided_at comes from the DB clock: a raw insert without it works,
        // and two rows with the same decided_at are ordered by id (higher wins).
        const [[{ decided_at: sameTime }]] = await sequelize.query(
            'SELECT decided_at FROM prv_review_verdicts WHERE item_id = $1 ORDER BY id DESC LIMIT 1', { bind: [open.id] });
        assert.ok(sameTime instanceof Date);
        await sequelize.query(
            `INSERT INTO prv_review_verdicts (item_id, verdict, reviewer, source) VALUES ($1, 'unclear', 'raw', 'page')`,
            { bind: [open.id] });
        await sequelize.query(
            `INSERT INTO prv_review_verdicts (item_id, verdict, reviewer, source, decided_at)
             VALUES ($1, 'sponsor', 'tie-a', 'page', '2100-01-01T00:00:00Z'), ($1, 'self_promotion', 'tie-b', 'page', '2100-01-01T00:00:00Z')`,
            { bind: [open.id] });
        const tie = await repo.getItem(batch, 'C7');
        assert.deepEqual(tie.history.slice(0, 3).map(h => h.reviewer), ['tie-b', 'tie-a', 'raw'],
            'same decided_at → higher id first; raw insert got a decided_at');
        assert.equal(tie.verdict.verdict, 'self_promotion');

        assert.equal(await repo.firstOpenItem(batch, 'bayanovea'), null);
        assert.equal(await repo.nextOpenItem(batch, 2, 'bayanovea'), null);
        assert.equal((await repo.defaultItem(batch, 'bayanovea')).item_code, 'C7', 'all decided → last item');
        assert.equal((await repo.firstOpenItem(batch, 'gkshi')).item_code, 'C2');
        assert.equal((await repo.nextOpenItem(batch, 2, 'gkshi')).item_code, 'C5');
        assert.deepEqual(await repo.getBatchProgress(batch, 'bayanovea'), batchRow(batch, { decided: 3, finished: ['bayanovea'], state: 'done' }));
        assert.equal(await repo.getItem(batch, 'C99'), null);
        assert.equal(await repo.defaultItem('e2e-review-no-such-batch', 'bayanovea'), null);
    });
});

test('review repository: take / give up / finish, availability per reviewer, one of two concurrent takes wins', async () => {
    const one = 'e2e-review-lock-one';
    const two = 'e2e-review-lock-two';
    const excl = 'e2e-review-lock-excluded';
    const NEWCOMER = 'e2e-newcomer';
    await withReviewRepo(async (repo, sequelize) => {
        await sequelize.query('INSERT INTO prv_review_reviewers (code) VALUES (:code)', { replacements: { code: NEWCOMER } });
        await repo.createBatch(two, { reviews_needed: 2 });
        await repo.createBatch(excl, { excluded: ['bayanovea'] });
    });
    try {
        for (const b of [one, two]) assert.equal(runImport(copyReviewFixture(b)).status, 0);   // bayanovea: C2, C5; C7 open
        assert.equal(runImport(copyReviewFixture(excl), ['--reviewer', 'gkshi']).status, 0);

        await withReviewRepo(async (repo) => {
            const state = async (batch, who) => (await repo.getBatchProgress(batch, who)).state;
            const conflict = (reason, locked_by = null) => (e) =>
                e instanceof ReviewConflictError && e.reason === reason && e.locked_by === locked_by;
            const inputError = (re) => (e) => e instanceof ReviewInputError && re.test(e.message);
            const decide = async (batch, codes, who) => {
                for (const code of codes) {
                    const item = await repo.getItem(batch, code);
                    await repo.recordVerdict({ item_id: item.id, verdict: 'not_ad', reviewer: who, source: 'page' });
                }
            };
            const unlocked = (batch) => ({ batch, locked_by: null, locked_at: null });

            // One review needed: bayanovea may come back to their half-done batch, gkshi may take it fresh.
            assert.equal(await state(one, 'bayanovea'), 'available');
            assert.equal(await state(one, 'gkshi'), 'available');
            const lock = await repo.takeBatch(one, 'gkshi');
            assert.equal(lock.batch, one);
            assert.equal(lock.locked_by, 'gkshi');
            assert.ok(lock.locked_at instanceof Date);
            assert.deepEqual(await repo.takeBatch(one, 'gkshi'), lock, 'taking a batch you hold is a no-op');
            assert.equal(await state(one, 'gkshi'), 'mine');
            assert.equal(await state(one, 'bayanovea'), 'locked');
            await assert.rejects(repo.takeBatch(one, 'bayanovea'), conflict('locked', 'gkshi'));
            assert.equal(await repo.canDecide(one, 'gkshi'), true);
            assert.equal(await repo.canDecide(one, 'bayanovea'), false);
            await assert.rejects(repo.releaseBatch(one, 'bayanovea'), conflict('locked', 'gkshi'), 'not the holder, no force');

            // gkshi decides C2 and gives up: the verdict stays, the lock goes.
            await decide(one, ['C2'], 'gkshi');
            assert.equal(await repo.releaseIfFinished(one, 'gkshi'), false, 'unfinished → lock kept');
            assert.deepEqual(await repo.releaseBatch(one, 'gkshi'), unlocked(one));
            assert.deepEqual(await repo.releaseBatch(one, 'gkshi'), unlocked(one), 'releasing a free batch is a no-op');
            assert.equal((await repo.getItem(one, 'C2')).verdict.reviewer, 'gkshi');

            // bayanovea takes it and finishes: lock cleared, the one review is done.
            await repo.takeBatch(one, 'bayanovea');
            await decide(one, ['C7'], 'bayanovea');
            assert.equal(await repo.releaseIfFinished(one, 'bayanovea'), true);
            assert.deepEqual(await repo.getBatchProgress(one, 'bayanovea'),
                batchRow(one, { decided: 3, finished: ['bayanovea'], state: 'done' }));
            assert.equal(await repo.canDecide(one, 'bayanovea'), true, 'may fix their own finished batch');
            await assert.rejects(repo.takeBatch(one, 'bayanovea'), conflict('done'));
            assert.equal(await state(one, NEWCOMER), 'closed', 'review count met → closed to newcomers');
            await assert.rejects(repo.takeBatch(one, NEWCOMER), conflict('closed'));
            // gkshi gave up halfway: the batch stays theirs to come back to.
            assert.equal(await state(one, 'gkshi'), 'available');
            await repo.takeBatch(one, 'gkshi');
            assert.deepEqual(await repo.releaseBatch(one, 'bayanovea', { force: true }), unlocked(one), 'force release');
            assert.equal(await state(one, 'gkshi'), 'available');

            // Two reviews needed: after bayanovea finishes, others may still take it; after the second, nobody new.
            await repo.takeBatch(two, 'bayanovea');
            await decide(two, ['C7'], 'bayanovea');
            assert.equal(await repo.releaseIfFinished(two, 'bayanovea'), true);
            assert.equal(await state(two, 'bayanovea'), 'done');
            assert.equal(await state(two, NEWCOMER), 'available');
            await repo.takeBatch(two, 'gkshi');
            await decide(two, ['C2', 'C5', 'C7'], 'gkshi');
            assert.equal(await repo.releaseIfFinished(two, 'gkshi'), true);
            assert.deepEqual(await repo.getBatchProgress(two, NEWCOMER),
                batchRow(two, { decided: 0, finished: ['bayanovea', 'gkshi'], state: 'closed', reviews_needed: 2 }));

            // Excluded reviewer: never available, and a holder does not make it "locked" for them.
            assert.equal(await state(excl, 'bayanovea'), 'closed');
            await assert.rejects(repo.takeBatch(excl, 'bayanovea'), conflict('closed'));
            await repo.takeBatch(excl, NEWCOMER);
            assert.equal(await state(excl, 'bayanovea'), 'closed');
            assert.equal(await state(excl, 'gkshi'), 'locked');
            assert.ok(!(await repo.listBatches({ reviewer: 'bayanovea' })).some(b => b.batch === excl));
            assert.equal((await repo.listBatches({ reviewer: 'bayanovea', all: true })).find(b => b.batch === excl).state, 'closed');
            await repo.releaseBatch(excl, NEWCOMER);

            // Concurrent takes: exactly one wins, the other gets the winner's name.
            for (let i = 0; i < 5; i++) {
                const results = await Promise.allSettled([repo.takeBatch(excl, 'gkshi'), repo.takeBatch(excl, NEWCOMER)]);
                const won = results.filter(r => r.status === 'fulfilled');
                assert.equal(won.length, 1, JSON.stringify(results));
                const lost = results.find(r => r.status === 'rejected').reason;
                assert.ok(conflict('locked', won[0].value.locked_by)(lost), String(lost));
                await repo.releaseBatch(excl, won[0].value.locked_by);
            }

            // createBatch never silently re-routes an existing batch.
            await assert.rejects(repo.createBatch(two, { reviews_needed: 1 }), inputError(/needs 2 review\(s\), not 1/));
            await assert.rejects(repo.createBatch(excl, { excluded: [] }), inputError(/excludes \{bayanovea\}, not \{\}/));
            assert.equal((await repo.createBatch(excl, { excluded: ['bayanovea', 'bayanovea'] })).batch, excl);
            assert.equal((await repo.createBatch(two)).reviews_needed, 2, 'nothing asked → stored row kept');
            await assert.rejects(repo.createBatch('e2e-review-lock-bad', { excluded: ['nobody'] }), inputError(/unknown reviewer nobody/));
            await assert.rejects(repo.createBatch('e2e-review-lock-bad', { reviews_needed: 0 }), inputError(/positive integer/));
            await assert.rejects(repo.takeBatch(one, 'nobody'), inputError(/unknown reviewer nobody/));
            assert.equal(await repo.takeBatch('e2e-review-no-such-batch', 'gkshi'), null);
            assert.equal(await repo.releaseBatch('e2e-review-no-such-batch', 'gkshi'), null);
        });
    } finally {
        // Later tests list the seeded reviewers only.
        await withReviewRepo((repo, sequelize) =>
            sequelize.query('DELETE FROM prv_review_reviewers WHERE code = :code', { replacements: { code: NEWCOMER } }));
    }
});

// ── Review page (prv/routes/admin-review.js) ──────────────────────────────────

const REVIEW_RUN = '2026-10-14-claude-sonnet-5-5-v2.1-batch-nt-think';

const REVIEWER = 'bayanovea';

// The page is Russian by default; text checks go through the same locale.
const RU = translator('ru');

function savedFlash(item, verdict, { track = false, flagged = 'run-kbd' } = {}) {
    return RU.text('js_saved', { item, verdict: RU.text(`verdict_${verdict}`), track: track ? RU.text('js_saved_track') : '', flagged });
}

function noChangeText(item, verdict) {
    return RU.text('js_no_change', { item, verdict: RU.text(`verdict_${verdict}`) });
}

function reviewPath(route, query = {}) {
    const qs = new URLSearchParams({ reviewer: REVIEWER, ...query, verifyBearerToken: MOD_AUTH });
    return `${route}?${qs}`;
}

function getReview(batch, query = {}) {
    return request('GET', reviewPath(`/admin/review/${encodeURIComponent(batch)}`, query), null);
}

function decideReview(payload, token = MOD_AUTH) {
    const qs = token == null ? '' : `?verifyBearerToken=${encodeURIComponent(token)}`;
    return request('POST', `/admin/review/decide${qs}`, payload);
}

function lockReview(action, batch, body, { token = MOD_AUTH, headers } = {}) {
    const qs = token == null ? '' : `?verifyBearerToken=${encodeURIComponent(token)}`;
    return request('POST', `/admin/review/${encodeURIComponent(batch)}/${action}${qs}`, body, headers);
}

async function takeReview(batch, reviewer = REVIEWER) {
    const res = await lockReview('take', batch, { reviewer });
    assert.equal(res.status, 200, `take ${batch} as ${reviewer} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
}

async function countReviewVerdicts(batch) {
    return (await reviewState(batch)).verdicts.length;
}

test('review page: 401 without or with a wrong token', async () => {
    assert.equal((await request('GET', '/admin/review', null)).status, 401);
    assert.equal((await request('GET', '/admin/review/any-batch', null)).status, 401);
    assert.equal((await request('GET', '/admin/review/any-batch?verifyBearerToken=wrong', null)).status, 401);
    assert.equal((await decideReview({ item_id: 1, verdict: 'sponsor', reviewer: 'x' }, null)).status, 401);
    assert.equal((await decideReview({ item_id: 1, verdict: 'sponsor', reviewer: 'x' }, 'wrong')).status, 401);
});

test('review page: default item is the first open one, blind until decided, decide → flagged_by + progress', async () => {
    const batch = 'e2e-review-page';
    assert.equal(runImport(copyReviewFixture(batch)).status, 0);   // C2 sponsor, C5 not_ad, C7 open

    // Batch list carries the progress.
    const list = await request('GET', reviewPath('/admin/review', { format: 'json' }), null);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.batches.find(b => b.batch === batch), batchRow(batch, { decided: 2 }));

    // No ?item → first open (C7).
    let r = await getReview(batch, { format: 'json' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.batch, batchRow(batch, { decided: 2 }));
    const item = r.body.item;
    assert.equal(item.item_code, 'C7');
    assert.equal(item.verdict, null);
    assert.deepEqual(item.history, []);
    assert.ok(!('flagged_by' in item), 'flagged_by must not be in JSON before a verdict');
    assert.ok(!JSON.stringify(r.body).includes(REVIEW_RUN), 'run id must not leak anywhere in the JSON');
    assert.equal(item.start_player, '1:02');
    assert.equal(item.end_player, '1:18');
    assert.equal(item.duration_s, 16);
    assert.equal(item.player_link, 'https://example.invalid/video-1_456000903?t=1m0s',
        'stored link already sits at start − 2 s and is used as is');
    assert.deepEqual(r.body.nav, {
        prev: { item_code: 'C5', decided: true, player_link: 'https://example.invalid/video-1_456000902?t=29m59s' },
        next: null,
        first_open: { item_code: 'C7', decided: false, player_link: 'https://example.invalid/video-1_456000903?t=1m0s' },
    });
    assert.deepEqual(r.body.signals.markups, []);
    assert.equal(r.body.signals.undos, 0);

    // HTML of the open item: no run id, but the player link and hotkeys script.
    const html = await getReview(batch);
    assert.equal(html.status, 200);
    assert.equal(typeof html.body, 'string');
    assert.ok(!html.body.includes(REVIEW_RUN), 'flagged_by must not be in HTML before a verdict');
    assert.ok(!html.body.includes('class="current flagged-by"'), 'no Flagged by block before a verdict');
    assert.ok(html.body.includes('href="https://example.invalid/video-1_456000903?t=1m0s"'));
    assert.ok(html.body.includes(RU('item_duration', { start: '1:02', end: '1:18', seconds: 16 })));
    assert.ok(html.body.includes("addEventListener('keydown'"));

    // A decided item shows its verdict, history and flagged_by.
    const c5 = await getReview(batch, { item: 'C5', format: 'json' });
    assert.equal(c5.body.item.verdict.verdict, 'not_ad');
    assert.deepEqual(c5.body.item.flagged_by, [REVIEW_RUN]);
    assert.deepEqual(c5.body.nav.prev, { item_code: 'C2', decided: true, player_link: 'https://example.invalid/video-1_456000901?t=4m20s' });
    assert.deepEqual(c5.body.nav.next, { item_code: 'C7', decided: false, player_link: 'https://example.invalid/video-1_456000903?t=1m0s' });
    const c5html = await getReview(batch, { item: 'C5' });
    assert.ok(c5html.body.includes('class="current flagged-by"'));
    assert.ok(c5html.body.includes(REVIEW_RUN));
    assert.ok(c5html.body.includes('Просьба покомментить есть'));

    // Decide C7 → 201 with flagged_by; nothing open any more, the last verdict releases the lock.
    await takeReview(batch);
    const d = await decideReview({ item_id: item.id, verdict: 'self_promotion', comment: ' plug ', reviewer: REVIEWER });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    assert.deepEqual(d.body, { item_id: item.id, item_code: 'C7', verdict: 'self_promotion', track_mismatch: false, flagged_by: [REVIEW_RUN], next_item: null, next_player_link: null });

    r = await getReview(batch, { item: 'C7', format: 'json' });
    assert.equal(r.body.item.verdict.verdict, 'self_promotion');
    assert.equal(r.body.item.verdict.comment, 'plug');
    assert.equal(r.body.item.verdict.reviewer, REVIEWER);
    assert.equal(r.body.item.verdict.source, 'page');
    assert.deepEqual(r.body.item.flagged_by, [REVIEW_RUN]);
    assert.deepEqual(r.body.batch, batchRow(batch, { decided: 3, finished: [REVIEWER], state: 'done' }));
    assert.equal(r.body.nav.first_open, null);
    // All decided → default is the last item.
    assert.equal((await getReview(batch, { format: 'json' })).body.item.item_code, 'C7');

    // Change of mind appends; latest wins, history kept.
    assert.equal((await decideReview({ item_id: item.id, verdict: 'not_ad', reviewer: 'bayanovea' })).status, 201);
    r = await getReview(batch, { item: 'C7', format: 'json' });
    assert.equal(r.body.item.verdict.verdict, 'not_ad');
    assert.equal(r.body.item.verdict.comment, null);
    assert.deepEqual(r.body.item.history.map(h => h.verdict), ['not_ad', 'self_promotion']);
    assert.equal(r.body.can_decide, true, 'a finished reviewer may fix their verdicts');
    const listAfter = await request('GET', reviewPath('/admin/review', { format: 'json' }), null);
    assert.deepEqual(listAfter.body.batches.find(b => b.batch === batch), batchRow(batch, { decided: 3, finished: ['bayanovea'], state: 'done' }));
});

test('review page: decide validation → 400 and no row written', async () => {
    const batch = 'e2e-review-page-bad';
    await withReviewRepo((repo) => repo.createBatch(batch, { reviews_needed: 2 }));
    assert.equal(runImport(copyReviewFixture(batch)).status, 0);
    const c7 = (await getReview(batch, { item: 'C7', format: 'json' })).body.item;
    const before = await countReviewVerdicts(batch);

    // Nobody holds the batch: 409 with the reason in the page language.
    let conflict = await decideReview({ item_id: c7.id, verdict: 'sponsor', reviewer: 'bayanovea' });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { reason: 'available', locked_by: null, message: RU.text('conflict_available') });
    await takeReview(batch);
    conflict = await request('POST', `/admin/review/decide?verifyBearerToken=${MOD_AUTH}`,
        { item_id: c7.id, verdict: 'sponsor', reviewer: 'gkshi' }, { Cookie: `${LANG_COOKIE}=en` });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body, { reason: 'locked', locked_by: 'bayanovea', message: 'bayanovea holds this batch.' });

    for (const [payload, msg] of [
        [{ item_id: c7.id, verdict: 'maybe', reviewer: 'bayanovea' }, /verdict must be one of/],
        [{ item_id: c7.id, verdict: 'not an ad', reviewer: 'bayanovea' }, /verdict must be one of/],
        [{ item_id: c7.id, verdict: 'sponsor' }, /reviewer/],
        [{ item_id: c7.id, verdict: 'sponsor', reviewer: '   ' }, /reviewer/],
        [{ item_id: c7.id, verdict: 'sponsor', reviewer: 'bayanovea', comment: 42 }, /comment/],
        [{ item_id: 99999999, verdict: 'sponsor', reviewer: 'bayanovea' }, /unknown review item/],
        [{ item_id: c7.id, verdict: 'sponsor', reviewer: 'x'.repeat(65) }, /unknown reviewer/],
        [{ item_id: c7.id, verdict: 'sponsor', reviewer: 'owner' }, /unknown reviewer owner/],
        [{ item_id: c7.id, verdict: 'sponsor', reviewer: 'bayanovea', track_mismatch: 'yes' }, /track_mismatch/],
        [{ item_id: 'abc', verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ item_id: String(c7.id), verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ item_id: '07', verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ item_id: 0, verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ item_id: -1, verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ item_id: 1.5, verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ item_id: 9999999999, verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
        [{ verdict: 'sponsor', reviewer: 'bayanovea' }, /item_id/],
    ]) {
        const res = await decideReview(payload);
        assert.equal(res.status, 400, `${JSON.stringify(payload)} → ${res.status}`);
        assert.match(String(res.body), msg);
    }
    assert.equal((await decideReview([1, 2])).status, 400);
    assert.equal(await countReviewVerdicts(batch), before, 'no verdict row written by bad requests');
    assert.equal((await getReview(batch, { item: 'C7', format: 'json' })).body.item.verdict, null);

    assert.equal((await getReview('e2e-review-no-such-batch', { format: 'json' })).status, 404);
    assert.equal((await getReview(batch, { item: 'C99', format: 'json' })).status, 404);

    // The reviewer code is trimmed; the same verdict again by the same
    // reviewer is not appended, by another reviewer it is.
    assert.equal((await decideReview({ item_id: c7.id, verdict: 'sponsor', reviewer: '  bayanovea ' })).status, 201);
    assert.equal((await decideReview({ item_id: c7.id, verdict: 'sponsor', reviewer: 'bayanovea' })).status, 201);
    await takeReview(batch, 'gkshi');   // bayanovea finished, the second review is open
    assert.equal((await decideReview({ item_id: c7.id, verdict: 'sponsor', reviewer: 'gkshi' })).status, 201);
    assert.deepEqual((await getReview(batch, { item: 'C7', format: 'json' })).body.item.history.map(h => h.reviewer), ['gkshi', 'bayanovea']);

    // Pages need a registered reviewer: none → picker (HTML) / 400 (JSON).
    const picker = await request('GET', `/admin/review?verifyBearerToken=${MOD_AUTH}`, null);
    assert.equal(picker.status, 200);
    assert.ok(picker.body.includes(RU('picker_prompt')) && picker.body.includes('reviewer=gkshi&amp;verifyBearerToken='));
    assert.deepEqual((await request('GET', `/admin/review?format=json&verifyBearerToken=${MOD_AUTH}`, null)).body, { reviewers: ['bayanovea', 'gkshi'], reviewer: null });
    assert.equal((await request('GET', `/admin/review?format=json&reviewer=owner&verifyBearerToken=${MOD_AUTH}`, null)).status, 400);
    const noRev = await request('GET', `/admin/review/${batch}?verifyBearerToken=${MOD_AUTH}`, null);
    assert.equal(noRev.status, 302);
    assert.equal(noRev.headers.location, `/admin/review?verifyBearerToken=${MOD_AUTH}`);
    assert.equal((await request('GET', `/admin/review/${batch}?format=json&reviewer=nobody&verifyBearerToken=${MOD_AUTH}`, null)).status, 400);
});

test('review page: save → next open item after the current one, wrapping round', async () => {
    const batch = 'e2e-review-page-next';
    assert.equal(runImport(copyReviewFixture(batch)).status, 0);   // C7 open
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        // Extra open items before and after C7.
        for (const [code, pos] of [['C1', 1], ['C9', 9]]) {
            await c.query(
                `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed)
                 VALUES ($1, $2, $3, '-1_1', 10, 20, 'sponsor')`, [batch, code, pos]);
        }
    } finally {
        await c.end();
    }
    assert.equal((await getReview(batch, { format: 'json' })).body.item.item_code, 'C1', 'first open by position');
    await takeReview(batch);
    const id = async (code) => (await getReview(batch, { item: code, format: 'json' })).body.item.id;

    let d = await decideReview({ item_id: await id('C7'), verdict: 'sponsor', reviewer: 'bayanovea' });
    assert.equal(d.body.next_item, 'C9');
    // Re-deciding an already decided item also moves on to the next open one.
    d = await decideReview({ item_id: await id('C5'), verdict: 'unclear', reviewer: 'bayanovea' });
    assert.equal(d.body.next_item, 'C9');
    d = await decideReview({ item_id: await id('C9'), verdict: 'unclear', reviewer: 'bayanovea' });
    assert.equal(d.body.next_item, 'C1', 'wraps round to the first open item');
    assert.equal(d.body.next_player_link, null, 'C1 has no stored link');
    d = await decideReview({ item_id: await id('C1'), verdict: 'not_ad', reviewer: 'bayanovea' });
    assert.equal(d.body.next_item, null);
    // C1 has no stored link → no player link (never computed).
    assert.equal((await getReview(batch, { item: 'C1', format: 'json' })).body.item.player_link, null);
    const c1html = (await getReview(batch, { item: 'C1' })).body;
    assert.ok(c1html.includes(RU('item_no_player')));
    assert.ok(!c1html.includes('id="player-link"'));
});

test('review page: user-controlled text is escaped in HTML and inline JSON', async () => {
    const batch = 'e2e-review-xss<b>"\'';
    const evil = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';
    const c = adminClient(TEST_DB);
    await c.connect();
    let itemId;
    try {
        itemId = (await c.query(
            `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by)
             VALUES ($1, 'C1', 1, '-1_2', 30, 40, 'sponsor', $2, 'javascript:alert(3)', $3) RETURNING id`,
            [batch, evil, JSON.stringify([evil])])).rows[0].id;
        await insertBatchRow(c, batch);
    } finally {
        await c.end();
    }
    await takeReview(batch);
    const d = await decideReview({ item_id: itemId, verdict: 'sponsor', comment: evil, reviewer: 'bayanovea' });
    assert.equal(d.status, 201);

    const r = await getReview(batch);
    assert.equal(r.status, 200);
    const html = r.body;
    assert.ok(!html.includes('<script>alert(1)'), 'cues/comment must be escaped');
    assert.ok(!html.includes('<img src=x'), 'no raw tags from data');
    // An unknown reviewer in the URL is never reflected: the picker comes back.
    const bad = await request('GET', `/admin/review?reviewer=${encodeURIComponent(evil)}&verifyBearerToken=${MOD_AUTH}`, null);
    assert.equal(bad.status, 200);
    assert.ok(bad.body.includes(RU('picker_prompt')) && !bad.body.includes('<img src=x') && !bad.body.includes('img%20src'));
    assert.ok(!html.includes('e2e-review-xss<b>'), 'batch name escaped');
    assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;alert(1)'));
    assert.ok(!html.includes('href="javascript:'), 'non-http link never rendered as href');
    assert.ok(!html.includes('javascript:alert(3)'), 'nor anywhere else (inline STATE included)');
    assert.ok(html.includes(RU('item_no_player')));
    assert.ok(html.includes('<meta name="referrer" content="no-referrer">'), 'token in the URL never sent as Referer');
    // Exactly one <script> element: the page's own, nothing injected.
    assert.equal(html.split('<script>').length - 1, 1);
    assert.equal(html.split('</script>').length - 1, 1);

    const list = await request('GET', reviewPath('/admin/review'), null);
    assert.ok(!list.body.includes('e2e-review-xss<b>'));
    assert.ok(list.body.includes(`/admin/review/${encodeURIComponent(batch).replace(/'/g, '&#39;')}?`));
});

test('review page: signals panel renders markups, segments, votes and links for the item stretch', async () => {
    const batch = 'e2e-review-page-signals';
    const nid = '__e2e__review_page_signals';
    const sponsor = cats.prv.sponsor;
    const c = adminClient(TEST_DB);
    await c.connect();
    const ids = {};
    try {
        const one = async (sql, params) => (await c.query(sql, params)).rows[0];
        await c.query(
            `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, link, flagged_by)
             VALUES ($1, 'C1', 1, $2, 200, 230, 'sponsor', 'https://example.invalid/video-1_9?t=3m18s', '["run-sig"]')`, [batch, nid]);
        await insertBatchRow(c, batch);
        ids.video = (await one(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt") VALUES ($1, 900, NOW(), NOW()) RETURNING id`, [nid])).id;
        ids.user = (await one(
            `INSERT INTO users (generated_user_id, rating, banned_at, "createdAt", "updatedAt") VALUES ('e2e-review-page-banned', -120, NOW(), NOW(), NOW()) RETURNING id`)).id;
        ids.markup = (await one(
            `INSERT INTO markups (video_id, user_id, internal_user_id, category_id, is_new, "createdAt", "updatedAt")
             VALUES ($1, 'e2e-review-page-banned', $2, $3, false, NOW(), NOW()) RETURNING id`, [ids.video, ids.user, sponsor])).id;
        await c.query(
            `INSERT INTO markup_time_intervals (markup_id, start, "end", "createdAt", "updatedAt") VALUES ($1, 205, 228, NOW(), NOW())`, [ids.markup]);
        ids.segment = (await one(
            `INSERT INTO prv_calculated_segments (video_id, category_id, start, "end", rating, "createdAt", "updatedAt")
             VALUES ($1, $2, 204, 229, -1, NOW(), NOW()) RETURNING id`, [ids.video, sponsor])).id;
        for (const [i, vote] of [1, -1, -1].entries()) {
            await c.query(
                `INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt")
                 VALUES ($1, $2, $3, 204, 229, $4, NOW(), NOW())`, [`e2e-review-page-voter-${i}`, ids.video, sponsor, vote]);
        }
        await c.query(
            `INSERT INTO prv_events_interval_undo (user_id, video_native_id, category_id, start, "end", "createdAt", "updatedAt")
             VALUES ('e2e-review-page', $1, $2, 210, 220, NOW(), NOW())`, [nid, sponsor]);
    } finally {
        await c.end();
    }

    const r = await getReview(batch, { format: 'json' });
    assert.equal(r.status, 200);
    const sig = r.body.signals;
    assert.deepEqual(sig.window, { start: 170, end: 260 });
    assert.deepEqual(sig.videos, [{ id: ids.video, duration: 900 }]);
    assert.deepEqual(sig.markups.map(m => [m.markup_id, m.user_id, m.author_banned]), [[ids.markup, ids.user, true]]);
    assert.deepEqual(sig.segments.map(x => [x.segment_id, x.rating, x.likes, x.dislikes]), [[ids.segment, -1, 1, 2]]);
    assert.equal(sig.undos, 1);

    const html = (await getReview(batch)).body;
    assert.ok(html.includes('Сигналы <span class="muted">(±30 с: 2:50 – 4:20)</span>'));
    assert.ok(html.includes(`href="/admin/video/${ids.video}?verifyBearerToken=${MOD_AUTH}"`), 'video page link');
    assert.ok(html.includes(`href="/admin/user/${ids.user}?verifyBearerToken=${MOD_AUTH}"`), 'author link by internal id');
    assert.ok(html.includes(`<span class="badge badge-banned">${RU('signals_banned')}</span>`));
    assert.ok(html.includes('3:25 – 3:48'), 'markup interval in player time');
    assert.ok(html.includes('>1 / 2</td>'), 'likes / dislikes');
    assert.ok(html.includes('Отмены: <strong>1</strong>'));
    assert.ok(!html.includes('run-sig'), 'still blind');
});

test('metrics: /admin/review/:batch normalizes to a stable label', async () => {
    await request('GET', '/admin/review/e2e-metrics-batch-1', null);
    await request('GET', '/admin/review/e2e-metrics-batch-2', null);
    await request('POST', '/admin/review/decide', {});
    await request('POST', '/admin/review/e2e-metrics-batch-1/take', {});
    await request('POST', '/admin/review/e2e-metrics-batch-2/release', {});
    await request('POST', '/admin/review/reviewers', {});
    const text = await fetchMetrics();
    assert.ok(httpDurationHasPath(text, '/admin/review/#batch'));
    assert.ok(httpDurationHasPath(text, '/admin/review/#batch/take'));
    assert.ok(httpDurationHasPath(text, '/admin/review/#batch/release'));
    assert.ok(!httpDurationHasPath(text, '/admin/review/e2e-metrics-batch-2/release'));
    assert.ok(!httpDurationHasPath(text, '/admin/review/e2e-metrics-batch-1'));
    assert.ok(httpDurationHasPath(text, '/admin/review/decide'), 'decide keeps its own label');
    assert.ok(httpDurationHasPath(text, '/admin/review/reviewers'), 'reviewers keeps its own label');
});

// ── Review page: keyboard-only pass ──────────────────────────────────────────
//
// Executes the page's real inline <script> (taken from the served HTML) in a
// vm context with a small stubbed DOM: the elements the script touches
// (#status, #track-flag, #comment, #save-btn, #player-link, the [data-verdict]
// buttons), document keydown listeners, focus/blur, localStorage /
// sessionStorage, location.href and window.open. fetch() goes to the real e2e
// server, so every save is a real POST /admin/review/decide and every
// navigation loads the real next page. The stubs are found by id /
// data-verdict only, so styling and attribute order can change freely.
// No browser in the e2e container; the same pass was also run once in
// headless Chrome against a throwaway local DB (see the plan, Task 7).

function htmlUnescape(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function memoryStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
}

// Storage that throws on every access (private window, blocked site data).
function brokenStorage() {
    const fail = () => { throw new Error('SecurityError: storage disabled'); };
    return { getItem: fail, setItem: fail, removeItem: fail };
}

// KeyboardEvent.code for a Latin key or digit, as a US layout reports it.
function keyCode(key) {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return key;
}

// One loaded page: parses the served HTML into stub elements and runs its script.
// This tab's opener, as `opener` in loadKeyboardPage: 'player' (cross-origin
// player tab a script opened: close() works), 'user-player' (cross-origin, but
// the reviewer opened that tab: close() is refused), 'same-origin' (batch list
// or a review page) or null.
function stubOpener(kind) {
    if (kind == null) return null;
    const crossOrigin = kind !== 'same-origin';
    return {
        closed: false,
        get location() {
            if (crossOrigin) throw new Error('SecurityError: cross-origin');
            return { href: '/admin/review' };
        },
        close() { if (kind !== 'user-player') this.closed = true; },
    };
}

function loadKeyboardPage(html, storages, { opener: openerKind = 'player' } = {}) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1, 'exactly one inline script');
    for (const id of ['status', 'track-flag', 'comment', 'save-btn']) {
        assert.ok(html.includes(`id="${id}"`), `page has #${id}`);
    }

    const page = { navigatedTo: null, opened: [], keydown: [], confirms: [], confirmAnswer: true };
    const body = { tagName: 'BODY', id: '' };
    const doc = { body, activeElement: body };
    const field = (tagName, id, value = '') => ({
        tagName, id, value, isContentEditable: false, textContent: '', className: '', disabled: false,
        focus() { doc.activeElement = this; },
        blur() { if (doc.activeElement === this) doc.activeElement = body; },
    });
    const comment = html.match(/<textarea[^>]*\bid="comment"[^>]*>([\s\S]*?)<\/textarea>/);
    const els = {
        status: field('DIV', 'status'),
        'track-flag': Object.assign(field('INPUT', 'track-flag'), { checked: /id="track-flag" checked/.test(html) }),
        comment: field('TEXTAREA', 'comment', comment ? htmlUnescape(comment[1]) : ''),
        'save-btn': field('BUTTON', 'save-btn'),
    };
    if (html.includes('id="player-link"')) els['player-link'] = field('A', 'player-link');
    if (html.includes('id="lock-status"')) els['lock-status'] = field('SPAN', 'lock-status');
    const buttons = [...html.matchAll(/<button\b[^>]*\bdata-verdict="([^"]+)"[^>]*>/g)].map(m => {
        const classAttr = (m[0].match(/\bclass="([^"]*)"/) || [, ''])[1];
        const classes = new Set(classAttr.split(/\s+/).filter(Boolean));
        return {
            tagName: 'BUTTON',
            dataset: { verdict: m[1] },
            classList: {
                contains: (c) => classes.has(c),
                toggle: (c, force) => { (force ?? !classes.has(c)) ? classes.add(c) : classes.delete(c); },
            },
        };
    });
    assert.equal(buttons.length, 4, 'four verdict buttons');

    Object.assign(doc, {
        getElementById: (id) => els[id] || null,
        querySelectorAll: (sel) => {
            assert.equal(sel, '.verdict-btn', `unexpected selector ${sel}`);
            return buttons;
        },
        addEventListener: (type, fn) => { if (type === 'keydown') page.keydown.push(fn); },
    });
    const location = {};
    Object.defineProperty(location, 'href', { set: (v) => { page.navigatedTo = v; }, get: () => '' });
    const opener = stubOpener(openerKind);
    const window = {
        opener,
        localStorage: storages.local,
        sessionStorage: storages.session,
        location,
        confirm: (message) => { page.confirms.push(message); return page.confirmAnswer; },
        // A popup blocker returns null; otherwise a window whose opener the page may clear.
        open: (url, target, features) => {
            page.opened.push({ url, target, features });
            return page.blockPopups ? null : { opener: window };
        },
    };
    const ctx = vm.createContext({
        window, document: doc, console,
        fetch: (url, opts) => fetch(`http://localhost:${E2E_PORT}${url}`, opts),
    });
    vm.runInContext(scripts[0][1], ctx);

    Object.assign(page, {
        els, doc, ctx, opener,
        state: () => vm.runInContext('STATE', ctx),
        selected: () => buttons.filter(b => b.classList.contains('selected')).map(b => b.dataset.verdict),
        active: () => doc.activeElement.id || doc.activeElement.tagName,
        // A key press as the browser delivers it: keydown to the focused
        // element (bubbling to document); a printable key not prevented by the
        // handler is typed into a focused text box. `code` defaults to the US
        // layout's; pass it for another layout (e.g. key 'о', code 'KeyJ').
        key(key, { ctrl = false, code = keyCode(key) } = {}) {
            const target = doc.activeElement;
            const ev = {
                key, code, target, ctrlKey: ctrl, metaKey: false, altKey: false, defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; },
            };
            page.keydown.forEach(fn => fn(ev));
            if (!ev.defaultPrevented && !ctrl && key.length === 1 && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
                target.value += key;
            }
        },
        type(text) { for (const ch of text) page.key(ch); },
        // The review page the user looks at after switching: the new tab when
        // the switch swapped tabs (this one became the player), else this tab.
        reviewUrl() {
            const tab = [...page.opened].reverse().find(o => o.url.startsWith('/admin/review/') && o.target === '_blank');
            return tab ? tab.url : page.navigatedTo;
        },
    });
    return page;
}

async function openKeyboardPage(path, storages, opts) {
    const res = await request('GET', path, null);
    assert.equal(res.status, 200, `GET ${path} → ${res.status}`);
    assert.equal(typeof res.body, 'string');
    return { html: res.body, page: loadKeyboardPage(res.body, storages, opts) };
}

// Press Enter (or Ctrl+Enter) and wait for the async save to navigate.
async function saveAndFollow(page, opts) {
    page.key('Enter', opts);
    for (let i = 0; i < 200 && !page.navigatedTo; i++) await sleep(10);
    assert.ok(page.navigatedTo, `save did not navigate; status: ${page.els.status.textContent}`);
    return page.reviewUrl();
}

// Items C1..Cn at 10·n s, each with the stored player link at start − 2 s;
// `holder` takes the batch (null: nobody).
async function seedKeyboardBatch(batch, count, { holder = REVIEWER } = {}) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        for (let pos = 1; pos <= count; pos++) {
            await c.query(
                `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by)
                 VALUES ($1, $2, $3, '-1_3', $4, $5, 'sponsor', 'cue', $6, '["run-kbd"]')`,
                [batch, `C${pos}`, pos, 10 * pos, 10 * pos + 5, `https://example.invalid/video-1_3?t=${10 * pos - 2}s`]);
        }
        await insertBatchRow(c, batch);
    } finally {
        await c.end();
    }
    if (holder) await takeReview(batch, holder);
}

test('review page: keyboard-only pass (1–4, Enter, c, Ctrl+Enter, Esc, j/k, o) decides a whole batch', async () => {
    const batch = 'e2e-review-keyboard';
    await seedKeyboardBatch(batch, 4);
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const itemPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;

    // Default item = first open; j / k navigate; o opens the player link.
    let { page, html } = await openKeyboardPage(reviewPath(`/admin/review/${batch}`), storages);
    assert.equal(page.state().item_code, 'C1');
    assert.equal(page.state().reviewer, REVIEWER);
    assert.ok(!html.includes('run-kbd'), 'blind before a verdict');
    assert.ok(!html.includes('id="reviewer"'), 'no Reviewer box: the reviewer comes from the URL');
    assert.ok(html.includes(RU('rules_title')), 'rules block on the page');
    page.key('k');
    assert.equal(page.navigatedTo, null, 'no previous item on C1');
    assert.deepEqual(page.opened, [], 'no item switch, no player');
    // Switching items swaps tabs: the new item opens in a new tab in front,
    // this tab turns into its player (loading behind the review page).
    page.key('j');
    assert.deepEqual(page.opened, [{ url: itemPath('C2'), target: '_blank', features: undefined }]);
    assert.equal(page.navigatedTo, 'https://example.invalid/video-1_3?t=18s');
    assert.equal(page.opener.closed, false, 'only a save closes the player tab');
    ({ page } = await openKeyboardPage(page.reviewUrl(), storages));
    assert.equal(page.state().item_code, 'C2');
    page.key('k');
    assert.equal(page.reviewUrl(), itemPath('C1'));
    assert.equal(page.navigatedTo, 'https://example.invalid/video-1_3?t=8s');
    ({ page } = await openKeyboardPage(page.reviewUrl(), storages));
    page.key('o');
    assert.deepEqual(page.opened, [{ url: 'https://example.invalid/video-1_3?t=8s', target: '_blank', features: 'noopener,noreferrer' }]);

    // C1: 1 + Enter saves under the URL's reviewer, no name to type.
    page.key('1');
    assert.deepEqual(page.selected(), ['sponsor']);
    page.opened.length = 0;
    assert.equal(await saveAndFollow(page), itemPath('C2'), 'save → next item in a new tab');
    assert.equal(page.navigatedTo, 'https://example.invalid/video-1_3?t=18s', 'this tab turns into its player');
    assert.equal(page.opener.closed, true, 'save closes the saved item\'s player tab');

    // C2: flash from the previous save; c → comment, a digit typed there is
    // text; Ctrl+Enter saves from the comment box.
    ({ page } = await openKeyboardPage(page.reviewUrl(), storages));
    assert.equal(page.els.status.textContent, savedFlash('C1', 'sponsor'));
    assert.equal(page.els.status.className, 'status ok');
    assert.equal(storages.session.getItem('adminReview.flash'), null, 'flash shown once');
    page.key('2');
    page.key('c');
    assert.equal(page.active(), 'comment');
    page.type('note 4');
    assert.deepEqual(page.selected(), ['self_promotion']);
    assert.equal(page.els.comment.value, 'note 4');
    assert.equal(await saveAndFollow(page, { ctrl: true }), itemPath('C3'));

    // C3: Enter without a verdict is refused; then 3 + Enter.
    ({ page } = await openKeyboardPage(page.reviewUrl(), storages));
    page.key('Enter');
    await sleep(20);
    assert.equal(page.navigatedTo, null);
    assert.equal(page.els.status.textContent, RU.text('js_pick_first', { n: 4 }));
    page.key('3');
    assert.equal(await saveAndFollow(page), itemPath('C4'));

    // C4: last open item → the page reloads C4, now decided and unblinded.
    ({ page } = await openKeyboardPage(page.reviewUrl(), storages));
    page.key('4');
    assert.equal(await saveAndFollow(page), itemPath('C4'));
    assert.deepEqual(page.opened, [], 'last open item reloads itself, no player');
    assert.equal(page.navigatedTo, itemPath('C4'));
    ({ page, html } = await openKeyboardPage(page.reviewUrl(), storages));
    assert.ok(html.includes(RU('item_progress', { decided: 4, total: 4, open: 0 })));
    assert.ok(html.includes('class="current flagged-by"') && html.includes('run-kbd'));
    assert.deepEqual(page.selected(), ['unclear']);
    assert.equal(page.els.status.textContent, savedFlash('C4', 'unclear'));

    const st = await reviewState(batch);
    assert.deepEqual(st.verdicts, [
        { item_code: 'C1', verdict: 'sponsor', comment: null, reviewer: REVIEWER, source: 'page' },
        { item_code: 'C2', verdict: 'self_promotion', comment: 'note 4', reviewer: REVIEWER, source: 'page' },
        { item_code: 'C3', verdict: 'not_ad', comment: null, reviewer: REVIEWER, source: 'page' },
        { item_code: 'C4', verdict: 'unclear', comment: null, reviewer: REVIEWER, source: 'page' },
    ]);
});

async function videoFlags(nativeId) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        return (await c.query(
            `SELECT flag, value, reviewer FROM prv_review_video_flags WHERE native_id = $1 ORDER BY created_at, id`, [nativeId])).rows;
    } finally {
        await c.end();
    }
}

test('review page: track flag (5) is saved per video next to the verdict; a flag-only save adds no verdict row', async () => {
    const batch = 'e2e-review-track-flag';
    await seedKeyboardBatch(batch, 3);   // all three items on native_id -1_3
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const itemPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;
    const gkshiPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=gkshi&verifyBearerToken=${MOD_AUTH}`;
    await (async () => { const c = adminClient(TEST_DB); await c.connect(); await c.query(`DELETE FROM prv_review_video_flags WHERE native_id = '-1_3'`); await c.end(); })();

    // 5 toggles the box; the flag is not a verdict (Enter still asks for one).
    let { page, html } = await openKeyboardPage(itemPath('C1'), storages);
    assert.ok(html.includes(RU('track_flag')));
    assert.equal(page.els['track-flag'].checked, false);
    page.key('5');
    assert.equal(page.els['track-flag'].checked, true);
    assert.deepEqual(page.selected(), []);
    page.key('Enter');
    await sleep(20);
    assert.equal(page.els.status.textContent, RU.text('js_pick_first', { n: 4 }));
    page.key('1');
    assert.equal(await saveAndFollow(page), itemPath('C2'));

    // C2 (same video): the box comes pre-checked with who set it; the JSON
    // carries the flag; the save flash names it.
    ({ page, html } = await openKeyboardPage(itemPath('C2'), storages));
    assert.equal(page.els.status.textContent, savedFlash('C1', 'sponsor', { track: true }));
    assert.equal(page.els['track-flag'].checked, true);
    assert.ok(html.includes(`включено: ${REVIEWER},`));
    const json = (await request('GET', itemPath('C2') + '&format=json', null)).body;
    assert.equal(json.video_flags.track_mismatch.value, true);
    assert.equal(json.video_flags.track_mismatch.reviewer, REVIEWER);
    assert.equal(json.reviewer, REVIEWER);
    assert.deepEqual(await videoFlags('-1_3'), [{ flag: 'track_mismatch', value: true, reviewer: REVIEWER }]);

    // Unchanged flag → no new flag row. Back on C1: a stray Enter is a no-op;
    // unticking the box and saving writes a flag row and no verdict row.
    page.key('2');
    assert.equal(await saveAndFollow(page), itemPath('C3'));
    assert.equal((await videoFlags('-1_3')).length, 1, 'same flag value is not appended');
    ({ page } = await openKeyboardPage(itemPath('C1'), storages));
    assert.deepEqual(page.selected(), ['sponsor']);
    page.key('Enter');
    await sleep(20);
    assert.equal(page.navigatedTo, null);
    assert.equal(page.els.status.textContent, noChangeText('C1', 'sponsor'));
    page.key('5');
    assert.equal(page.els['track-flag'].checked, false);
    assert.equal(await saveAndFollow(page), itemPath('C3'), 'flag-only save moves on to the next open item');
    assert.deepEqual(await videoFlags('-1_3'), [
        { flag: 'track_mismatch', value: true, reviewer: REVIEWER },
        { flag: 'track_mismatch', value: false, reviewer: REVIEWER },
    ]);
    ({ page } = await openKeyboardPage(itemPath('C1'), storages));
    assert.equal(page.els['track-flag'].checked, false);
    assert.equal(page.els.status.textContent, savedFlash('C1', 'sponsor'));

    // Another reviewer (other URL) agreeing with C1 adds a verdict row under their
    // code, once bayanovea gives the batch up and gkshi takes it.
    assert.equal((await lockReview('release', batch, { reviewer: REVIEWER })).status, 200);
    await takeReview(batch, 'gkshi');
    ({ page } = await openKeyboardPage(gkshiPath('C1'), storages));
    assert.deepEqual(page.selected(), [], 'buttons start from the reviewer\'s own verdict');
    page.key('1');
    assert.equal(page.state().reviewer, 'gkshi');
    assert.equal(await saveAndFollow(page), gkshiPath('C2'), 'links keep the reviewer; next open is gkshi\'s');

    assert.deepEqual((await reviewState(batch)).verdicts, [
        { item_code: 'C1', verdict: 'sponsor', comment: null, reviewer: REVIEWER, source: 'page' },
        { item_code: 'C1', verdict: 'sponsor', comment: null, reviewer: 'gkshi', source: 'page' },
        { item_code: 'C2', verdict: 'self_promotion', comment: null, reviewer: REVIEWER, source: 'page' },
    ]);
});

test('review page: batch list shows the reviewer\'s state per batch; closed batches only with show=all', async () => {
    const mine = 'e2e-review-state-mine';
    const theirs = 'e2e-review-state-theirs';
    const anyone = 'e2e-review-state-anyone';
    const excluded = 'e2e-review-state-excluded';
    await withReviewRepo((repo) => repo.createBatch(excluded, { excluded: [REVIEWER] }));
    assert.equal(runImport(copyReviewFixture(mine)).status, 0);
    for (const b of [theirs, anyone, excluded]) {
        const r = runImport(copyReviewFixture(b), ['--reviewer', 'gkshi']);
        assert.equal(r.status, 0, r.stderr);
    }
    assert.deepEqual((await reviewState(theirs)).verdicts.map(v => v.reviewer), ['gkshi', 'gkshi'], '--reviewer names the md verdicts');
    const gone = runImport(copyReviewFixture(anyone), ['--batch', anyone, '--assignee', 'gkshi']);
    assert.equal(gone.status, 2);
    assert.match(gone.stderr, /--assignee is gone/);
    await withReviewRepo(async (repo) => {
        await repo.takeBatch(mine, REVIEWER);
        await repo.takeBatch(theirs, 'gkshi');
    });

    const states = (res) => Object.fromEntries(res.body.batches
        .filter(b => b.batch.startsWith('e2e-review-state-')).map(b => [b.batch, [b.state, b.locked_by]]));
    const asMe = await request('GET', reviewPath('/admin/review', { format: 'json' }), null);
    assert.equal(asMe.body.reviewer, REVIEWER);
    assert.deepEqual(states(asMe), { [mine]: ['mine', REVIEWER], [theirs]: ['locked', 'gkshi'], [anyone]: ['available', null] });
    const row = asMe.body.batches.find(b => b.batch === mine);
    assert.ok(row.locked_at);
    assert.deepEqual({ ...row, locked_at: null }, batchRow(mine, { decided: 2, locked_by: REVIEWER, state: 'mine' }));
    assert.ok(!('assignee' in row));
    const asGkshi = await request('GET', reviewPath('/admin/review', { format: 'json', reviewer: 'gkshi' }), null);
    assert.deepEqual(states(asGkshi), {
        [mine]: ['locked', REVIEWER], [theirs]: ['mine', 'gkshi'], [anyone]: ['available', null], [excluded]: ['available', null],
    });
    const all = await request('GET', reviewPath('/admin/review', { format: 'json', show: 'all' }), null);
    assert.deepEqual(states(all)[excluded], ['closed', null]);

    const html = await request('GET', reviewPath('/admin/review'), null);
    assert.ok(html.body.includes(RU('toolbar_reviewer_html', { name: REVIEWER })));
    assert.ok(html.body.includes(`/admin/review/${mine}?reviewer=${REVIEWER}&amp;verifyBearerToken=`));
    assert.ok(html.body.includes(RU('state_mine')));
    assert.ok(html.body.includes(RU('state_locked', { name: 'gkshi' })));
    assert.ok(!html.body.includes(`/admin/review/${excluded}?`), 'closed batch hidden by default');
    assert.ok(html.body.includes('show=all'));
    // Opening a batch someone else holds is allowed but says so.
    const theirsPage = await request('GET', reviewPath(`/admin/review/${theirs}`), null);
    assert.ok(theirsPage.body.includes(RU('lock_locked', { name: 'gkshi' })));
    for (const key of ['list_section_mine', 'list_section_available', 'list_section_locked']) assert.ok(html.body.includes(RU(key)), key);
    assert.ok(!html.body.includes(RU('list_section_closed')));
    const allHtml = await request('GET', reviewPath('/admin/review', { show: 'all' }), null);
    assert.ok(allHtml.body.includes(RU('list_section_closed')));
    assert.ok(allHtml.body.indexOf(RU('list_section_mine')) < allHtml.body.indexOf(RU('list_section_closed')), 'sections in order');
});

test('review page: take → decide → finish unlocks; no lock → 409 and read-only page; force release; second reviewer starts at C1', async () => {
    const batch = 'e2e-review-take';
    await withReviewRepo((repo) => repo.createBatch(batch, { reviews_needed: 2 }));
    await seedKeyboardBatch(batch, 3, { holder: null });
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const itemPath = (code, who = REVIEWER) => `/admin/review/${batch}?item=${code}&reviewer=${who}&verifyBearerToken=${MOD_AUTH}`;
    const json = async (who = REVIEWER) => (await request('GET', reviewPath(`/admin/review/${batch}`, { reviewer: who, format: 'json' }), null)).body;
    const decide = async (code, verdict, who = REVIEWER) => {
        const item = (await request('GET', itemPath(code, who) + '&format=json', null)).body.item;
        return decideReview({ item_id: item.id, verdict, reviewer: who });
    };
    const lockOf = async () => (await json()).batch.locked_by;
    const runLock = async (page, action, force) => {
        await vm.runInContext(`lockAction('${action}', ${force})`, page.ctx);
        return page.navigatedTo;
    };

    // Free batch: banner with "Take it", controls disabled, hotkeys only explain.
    let body = await json();
    assert.equal(body.batch.state, 'available');
    assert.equal(body.can_decide, false);
    let { page, html } = await openKeyboardPage(itemPath('C1'), storages);
    assert.ok(html.includes('class="card lock lock-available"') && html.includes(RU('lock_available')));
    assert.ok(html.includes(`onclick="lockAction('take', false)">${RU('lock_take')}</button>`));
    assert.match(html, /data-verdict="sponsor" onclick="pick\('sponsor'\)" disabled>/);
    assert.match(html, /id="save-btn" onclick="save\(\)" disabled>/);
    page.key('1');
    assert.deepEqual(page.selected(), []);
    assert.equal(page.els.status.textContent, RU.text('js_read_only'));
    page.key('Enter');
    await sleep(20);
    assert.equal(page.navigatedTo, null);
    assert.equal(await countReviewVerdicts(batch), 0);

    // Take it from the banner → reload as holder.
    assert.equal(await runLock(page, 'take', false), itemPath('C1'));
    body = await json();
    assert.equal(body.batch.state, 'mine');
    assert.equal(body.can_decide, true);
    ({ html } = await openKeyboardPage(itemPath('C1'), storages));
    assert.ok(html.includes('lock-mine') && html.includes(`onclick="lockAction('release', false)">${RU('lock_release')}</button>`));

    // gkshi sees the holder: take, release and decide → 409; the page offers a force release.
    let res = await lockReview('take', batch, { reviewer: 'gkshi' });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { reason: 'locked', locked_by: REVIEWER, message: RU.text('conflict_locked', { name: REVIEWER }) });
    res = await lockReview('release', batch, { reviewer: 'gkshi' });
    assert.equal(res.status, 409);
    assert.equal(res.body.locked_by, REVIEWER);
    assert.equal((await decide('C1', 'sponsor', 'gkshi')).status, 409);
    ({ page, html } = await openKeyboardPage(itemPath('C1', 'gkshi'), storages));
    assert.ok(html.includes('lock-locked') && html.includes(RU('lock_locked', { name: REVIEWER })));
    assert.ok(html.includes(`onclick="lockAction('release', true)">${RU('lock_release')}</button>`));
    page.confirmAnswer = false;
    assert.equal(await runLock(page, 'release', true), null, 'cancelled confirm does nothing');
    assert.deepEqual(page.confirms, [RU.text('js_force_confirm', { name: REVIEWER })]);
    assert.equal(await lockOf(), REVIEWER);
    page.confirmAnswer = true;
    assert.equal(await runLock(page, 'release', true), itemPath('C1', 'gkshi'));
    assert.equal(await lockOf(), null, 'force release');

    // Bad lock requests.
    assert.equal((await lockReview('take', batch, { reviewer: REVIEWER }, { token: null })).status, 401);
    assert.equal((await lockReview('take', batch, { reviewer: 'nobody' })).status, 400);
    assert.equal((await lockReview('release', batch, { reviewer: REVIEWER, force: 'yes' })).status, 400);
    assert.equal((await lockReview('take', 'e2e-review-no-such-batch', { reviewer: REVIEWER })).status, 404);

    // bayanovea takes it back and finishes: each save → next open, the last one unlocks.
    const lock = await takeReview(batch);
    assert.equal(lock.batch, batch);
    assert.equal(lock.locked_by, REVIEWER);
    assert.ok(lock.locked_at);
    assert.equal((await decide('C1', 'sponsor')).body.next_item, 'C2');
    assert.equal((await decide('C2', 'not_ad')).body.next_item, 'C3');
    assert.equal(await lockOf(), REVIEWER);
    assert.equal((await decide('C3', 'not_ad')).body.next_item, null);
    body = await json();
    assert.equal(body.batch.state, 'done');
    assert.equal(body.batch.locked_by, null, 'last verdict releases the lock');
    assert.deepEqual(body.batch.finished, [REVIEWER]);

    // Second review: gkshi starts at C1, sees bayanovea's verdict, no button pre-selected.
    await takeReview(batch, 'gkshi');
    body = await json('gkshi');
    assert.equal(body.item.item_code, 'C1');
    assert.equal(body.item.own_verdict, null);
    assert.equal(body.item.verdict.reviewer, REVIEWER);
    assert.deepEqual(body.item.history.map(h => h.reviewer), [REVIEWER]);
    assert.equal(body.batch.decided, 0);
    assert.equal(body.nav.first_open.item_code, 'C1');
    ({ page, html } = await openKeyboardPage(itemPath('C1', 'gkshi'), storages));
    assert.ok(html.includes(RU('current_verdict')));
    assert.deepEqual(page.selected(), []);
    page.key('3');
    assert.equal(await saveAndFollow(page), itemPath('C2', 'gkshi'), 'next open for gkshi');
    // bayanovea (finished) may still fix their verdict while gkshi holds the batch; their buttons show their own.
    ({ page } = await openKeyboardPage(itemPath('C1'), storages));
    assert.deepEqual(page.selected(), ['sponsor']);
    assert.equal((await decide('C1', 'unclear')).status, 201);
    assert.equal(await lockOf(), 'gkshi', 'a fix by a finished reviewer keeps the holder\'s lock');
    assert.deepEqual((await reviewState(batch)).verdicts.map(v => [v.item_code, v.verdict, v.reviewer]), [
        ['C1', 'sponsor', REVIEWER], ['C1', 'not_ad', 'gkshi'], ['C1', 'unclear', REVIEWER],
        ['C2', 'not_ad', REVIEWER], ['C3', 'not_ad', REVIEWER],
    ]);
});

test('review page: create reviewer (form / JSON) → picker → batch list → item page → take → decide, a Cyrillic name with a space round-trips', async () => {
    const NAME = 'Анна Петрова-2';
    const batch = 'e2e-review-create-reviewer';
    const enc = encodeURIComponent(NAME);
    const created = [NAME, 'Zoë Ng'];
    const qs = (token) => (token == null ? '' : `?verifyBearerToken=${encodeURIComponent(token)}`);
    const form = (name, { token = MOD_AUTH, headers = {} } = {}) => request('POST', `/admin/review/reviewers${qs(token)}`,
        new URLSearchParams({ name }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded', ...headers });
    const create = (body, token = MOD_AUTH) => request('POST', `/admin/review/reviewers${qs(token)}`, body);
    await seedKeyboardBatch(batch, 2, { holder: null });
    const storages = { local: memoryStorage(), session: memoryStorage() };
    try {
        assert.equal((await form(NAME, { token: null })).status, 401);
        assert.equal((await create({ name: NAME }, 'wrong')).status, 401);

        // The picker offers the form; the form lands on the new reviewer's batch list.
        let picker = await request('GET', `/admin/review?verifyBearerToken=${MOD_AUTH}`, null);
        assert.ok(picker.body.includes(`<form class="card create-reviewer" method="post" action="/admin/review/reviewers?verifyBearerToken=${MOD_AUTH}">`));
        assert.ok(picker.body.includes('name="name" maxlength="64" required value=""') && picker.body.includes(RU('picker_create_button')));
        let res = await form(`  ${NAME} `);
        assert.equal(res.status, 303);
        const listPath = `/admin/review?reviewer=${enc}&verifyBearerToken=${MOD_AUTH}`;
        assert.equal(res.headers.location, listPath);
        picker = await request('GET', `/admin/review?verifyBearerToken=${MOD_AUTH}`, null);
        assert.ok(picker.body.includes(`<a href="${listPath.replace('&', '&amp;')}">${NAME}</a>`), 'listed in the picker');

        const list = await request('GET', listPath, null);
        assert.equal(list.status, 200);
        assert.ok(list.body.includes(RU('toolbar_reviewer_html', { name: NAME })));
        const row = (await request('GET', `${listPath}&format=json`, null)).body;
        assert.equal(row.reviewer, NAME);
        assert.equal(row.batches.find(b => b.batch === batch).state, 'available');
        const link = list.body.match(new RegExp(`<a class="batch-link" href="([^"]*/admin/review/${batch}\\?[^"]*)"`))[1];
        assert.equal(htmlUnescape(link), `/admin/review/${batch}?reviewer=${enc}&verifyBearerToken=${MOD_AUTH}`);

        // Item page → take → decide, all through the page's own URLs and fetches.
        let { page } = await openKeyboardPage(htmlUnescape(link), storages);
        assert.equal(page.state().reviewer, NAME);
        await vm.runInContext("lockAction('take', false)", page.ctx);
        const c1 = `/admin/review/${batch}?item=C1&reviewer=${enc}&verifyBearerToken=${MOD_AUTH}`;
        assert.equal(page.navigatedTo, c1);
        ({ page } = await openKeyboardPage(c1, storages));
        page.key('1');
        assert.equal(await saveAndFollow(page), `/admin/review/${batch}?item=C2&reviewer=${enc}&verifyBearerToken=${MOD_AUTH}`);
        const c2 = (await getReview(batch, { reviewer: NAME, item: 'C2', format: 'json' })).body.item;
        assert.equal((await decideReview({ item_id: c2.id, verdict: 'not_ad', reviewer: NAME })).status, 201);
        assert.deepEqual((await reviewState(batch)).verdicts.map(v => [v.item_code, v.verdict, v.reviewer]),
            [['C1', 'sponsor', NAME], ['C2', 'not_ad', NAME]]);
        const done = (await getReview(batch, { reviewer: NAME, format: 'json' })).body.batch;
        assert.equal(done.state, 'done');
        assert.deepEqual(done.finished, [NAME]);

        // Taken in another letter case → 400, nothing added; JSON create cleans the name.
        res = await create({ name: 'АННА  петрова-2' });
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { reason: 'taken', message: RU.text('reviewer_taken', { name: 'АННА петрова-2' }) });
        res = await form('GKSHI');
        assert.equal(res.status, 400);
        assert.ok(res.body.includes(RU('reviewer_taken', { name: 'GKSHI' })) && res.body.includes('value="GKSHI"'));
        res = await create({ name: '  Zoë   Ng ' });
        assert.equal(res.status, 201);
        assert.deepEqual(res.body, { code: 'Zoë Ng' });

        // Bad names → 400: the form keeps the (escaped) input and speaks the page language.
        for (const body of [{}, { name: '' }, { name: 'a/b' }, { name: 'x'.repeat(65) }, { name: 42 }, []]) {
            res = await create(body);
            assert.equal(res.status, 400, JSON.stringify(body));
            assert.equal(res.body.reason, 'invalid');
        }
        res = await form('<b>x</b>', { headers: { Cookie: 'review_lang=en' } });
        assert.equal(res.status, 400);
        assert.ok(res.body.includes('<html lang="en">') && res.body.includes('This name is not allowed.'));
        assert.ok(res.body.includes('value="&lt;b&gt;x&lt;/b&gt;"') && !res.body.includes('<b>x</b>'));
        assert.ok(res.body.includes(`href="/admin/review?verifyBearerToken=${MOD_AUTH}&amp;lang=ru"`), 'the switch points at the picker');
        assert.deepEqual((await request('GET', `/admin/review?format=json&verifyBearerToken=${MOD_AUTH}`, null)).body.reviewers.sort(),
            ['bayanovea', 'gkshi', 'Zoë Ng', NAME].sort());
    } finally {
        // Later tests list the seeded reviewers only; a boot would rewrite these verdicts to bayanovea.
        await withReviewRepo(async (repo, sequelize) => {
            await sequelize.query('DELETE FROM prv_review_verdicts WHERE reviewer IN (:created)', { replacements: { created } });
            await sequelize.query('DELETE FROM prv_review_reviewers WHERE code IN (:created)', { replacements: { created } });
        });
    }
});

test('review page: a save closes only the cross-origin player tab it was switched from', async () => {
    const batch = 'e2e-review-close-player';
    await seedKeyboardBatch(batch, 4);
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const itemPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;
    const HAND = RU.text('js_close_by_hand');

    // The batch list opens a batch in a script-opened tab.
    const list = await request('GET', reviewPath('/admin/review'), null);
    assert.ok(list.body.includes(`class="batch-link" href="/admin/review/${batch}?`));
    assert.ok(list.body.includes("window.open(a.href, '_blank')"));

    // Opened from the batch list: the same-origin opener stays.
    let { page } = await openKeyboardPage(itemPath('C1'), storages, { opener: 'same-origin' });
    page.key('1');
    assert.equal(await saveAndFollow(page), itemPath('C2'));
    assert.equal(page.opener.closed, false, 'batch list tab is not a player');

    // Player in the tab the reviewer opened: the browser refuses, the flash says so.
    ({ page } = await openKeyboardPage(itemPath('C2'), storages, { opener: 'user-player' }));
    assert.ok(!page.els.status.textContent.includes(HAND));
    page.key('1');
    assert.equal(await saveAndFollow(page), itemPath('C3'));
    assert.equal(page.opener.closed, false);
    ({ page } = await openKeyboardPage(itemPath('C3'), storages, { opener: null }));
    assert.equal(page.els.status.textContent, savedFlash('C2', 'sponsor') + '. ' + HAND,
        page.els.status.textContent);

    // No opener: nothing to close, plain flash.
    page.key('1');
    assert.equal(await saveAndFollow(page), itemPath('C4'));
    ({ page } = await openKeyboardPage(itemPath('C4'), storages));
    assert.equal(page.els.status.textContent, savedFlash('C3', 'sponsor'));
});

test('review page: keyboard edge cases (Russian layout, focused link, errors, no-change guard, broken storage)', async () => {
    const batch = 'e2e-review-keyboard-edge';
    await seedKeyboardBatch(batch, 2);
    // Storage that throws everywhere: the page still works, nothing is remembered.
    const storages = { local: brokenStorage(), session: brokenStorage() };
    const itemPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;

    let { page } = await openKeyboardPage(itemPath('C1'), storages);
    assert.equal(page.els.status.textContent, '');

    // Russian layout: letters arrive as Cyrillic, the physical key decides.
    // With popups blocked the switch falls back to plain navigation (no player).
    page.blockPopups = true;
    page.key('о', { code: 'KeyJ' });
    assert.deepEqual(page.opened.map(o => o.url), [itemPath('C2')], 'tried the new tab');
    assert.equal(page.navigatedTo, itemPath('C2'));
    page.blockPopups = false;
    page.navigatedTo = null;
    page.opened.length = 0;

    // After clicking "Open in player" the link has focus: hotkeys still work,
    // only Enter keeps its link meaning (no save).
    page.els['player-link'].focus();
    page.key('щ', { code: 'KeyO' });
    assert.deepEqual(page.opened, [{ url: 'https://example.invalid/video-1_3?t=8s', target: '_blank', features: 'noopener,noreferrer' }]);
    page.key('1');
    assert.deepEqual(page.selected(), ['sponsor']);
    page.key('Enter');
    await sleep(20);
    assert.equal(page.navigatedTo, null);
    assert.equal(page.els.status.textContent, '', 'Enter on the link did not try to save');

    // A server error is shown and the button comes back; a double Enter posts once.
    page.els['save-btn'].focus();
    const realId = page.state().item_id;
    vm.runInContext('STATE.item_id = 2147483647', page.ctx);
    page.key('Enter');
    for (let i = 0; i < 200 && page.els.status.className !== 'status error'; i++) await sleep(10);
    assert.equal(page.els.status.textContent, RU.text('js_error_status', { status: 400, text: 'unknown review item 2147483647' }));
    assert.equal(page.els.status.className, 'status error');
    assert.equal(page.els['save-btn'].disabled, false, 'button re-enabled after an error');
    assert.equal(page.opener.closed, false, 'a failed save keeps the player tab');
    assert.equal(page.navigatedTo, null);
    vm.runInContext(`STATE.item_id = ${realId}`, page.ctx);
    page.key('Enter');
    assert.equal(page.els['save-btn'].disabled, true, 'saving');
    // saveAndFollow presses Enter a second time while the first save is in flight.
    assert.equal(await saveAndFollow(page), itemPath('C2'));
    await sleep(50);
    assert.equal((await reviewState(batch)).verdicts.length, 1, 'double Enter posted once');

    // Back on the decided C1: a stray Enter does not append a copy of the
    // verdict; a changed comment does.
    ({ page } = await openKeyboardPage(itemPath('C1'), storages));
    assert.deepEqual(page.selected(), ['sponsor']);
    page.key('Enter');
    await sleep(20);
    assert.equal(page.navigatedTo, null);
    assert.equal(page.els.status.textContent, noChangeText('C1', 'sponsor'));
    page.key('с', { code: 'KeyC' });
    assert.equal(page.active(), 'comment');
    page.type('why');
    assert.equal(await saveAndFollow(page, { ctrl: true }), itemPath('C2'));

    assert.deepEqual((await reviewState(batch)).verdicts, [
        { item_code: 'C1', verdict: 'sponsor', comment: null, reviewer: REVIEWER, source: 'page' },
        { item_code: 'C1', verdict: 'sponsor', comment: 'why', reviewer: REVIEWER, source: 'page' },
    ]);
});

test('review page: Russian by default, ?lang=en switches to English and sticks via the cookie', async () => {
    const batch = 'e2e-review-lang';
    await seedKeyboardBatch(batch, 1);
    const itemPath = `/admin/review/${batch}?item=C1&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;
    const enCookie = { Cookie: `${LANG_COOKIE}=en` };

    const ru = await request('GET', itemPath, null);
    assert.equal(ru.status, 200);
    assert.ok(ru.body.includes('<html lang="ru">'));
    assert.ok(ru.body.includes('Как решать'));
    assert.ok(ru.body.includes('Сохранить ⏎'));
    assert.ok(/data-verdict="sponsor"[^>]*>.*Спонсор<\/button>/.test(ru.body), 'label translated, value kept');
    assert.ok(ru.body.includes(`href="/admin/review/${batch}?item=C1&amp;reviewer=${REVIEWER}&amp;verifyBearerToken=${MOD_AUTH}&amp;lang=en">English</a>`));
    assert.equal(ru.headers['set-cookie'], undefined, 'no cookie without ?lang=');

    const en = await request('GET', `${itemPath}&lang=en`, null);
    assert.ok(en.body.includes('<html lang="en">'));
    assert.ok(en.body.includes('How to decide'));
    assert.ok(/data-verdict="self_promotion"[^>]*>.*Self-promotion<\/button>/.test(en.body));
    assert.ok(en.body.includes('&amp;lang=ru">Русский</a>'));
    const cookie = en.headers['set-cookie'][0];
    assert.match(cookie, new RegExp(`^${LANG_COOKIE}=en;`));
    assert.match(cookie, /Path=\/admin\/review/);
    assert.match(cookie, /Max-Age=31536000/);

    // The cookie alone keeps English on every page; ?lang=ru wins over it.
    const picker = await request('GET', `/admin/review?verifyBearerToken=${MOD_AUTH}`, null, enCookie);
    assert.ok(picker.body.includes('<html lang="en">') && picker.body.includes('Who are you? Every verdict is saved under this name.'));
    assert.ok(picker.body.includes(`href="/admin/review?verifyBearerToken=${MOD_AUTH}&amp;lang=ru">Русский</a>`));
    const list = await request('GET', reviewPath('/admin/review'), null, enCookie);
    assert.ok(list.body.includes(`Reviewer: <strong>${REVIEWER}</strong>`) && list.body.includes('<th>Decided</th>'));
    const back = await request('GET', `${itemPath}&lang=ru`, null, enCookie);
    assert.ok(back.body.includes('Как решать'));
    assert.match(back.headers['set-cookie'][0], new RegExp(`^${LANG_COOKIE}=ru;`));
    const unknown = await request('GET', `${itemPath}&lang=de`, null, enCookie);
    assert.ok(unknown.body.includes('How to decide'), 'unknown lang: cookie still decides');
    assert.equal(unknown.headers['set-cookie'], undefined);

    // Client-side texts come with the page language.
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const page = loadKeyboardPage((await request('GET', itemPath, null, enCookie)).body, storages);
    page.key('Enter');
    assert.equal(page.els.status.textContent, 'Pick a verdict first (1–4).');
    page.key('1');
    assert.equal(await saveAndFollow(page), itemPath);
    const saved = loadKeyboardPage((await request('GET', itemPath, null, enCookie)).body, storages);
    assert.equal(saved.els.status.textContent, 'Saved C1: Sponsor. Flagged by: run-kbd');
    saved.key('Enter');
    assert.equal(saved.els.status.textContent, 'No change: C1 is already Sponsor.');
});
