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
const { ReviewInputError, ReviewConflictError, mayDecide } = createReviewRepository;

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
let aiFirstProc; // a second app with AI_FIRST=on, started by the first AI-first test
let cats = {}; // { prv: { intro, sponsor }, rt: { intro, sponsor }, yt: { intro } }

// ── Setup / Teardown ──────────────────────────────────────────────────────────

before(async () => {
    await createDb();
    serverProc = startServer();
    await waitForSchema();
    await waitForListen();
    cats.prv = await loadCats('');
    cats.rt = await loadCats('rt_');
    cats.yt = await loadCats('yt_');
});

after(async () => {
    stopServer();
    if (aiFirstProc) aiFirstProc.kill();
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

// An env value of undefined drops the variable.
function startServer(port = E2E_PORT, env = {}, tag = 'server') {
    const e = { ...process.env, DB_NAME: TEST_DB, NODE_APP_PORT: String(port), ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const proc = spawn('node', ['server.js'], {
        cwd: APP_DIR,
        env: e,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', d => process.stdout.write(`[${tag}] ${d}`));
    proc.stderr.on('data', d => process.stderr.write(`[${tag}] ${d}`));
    return proc;
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
async function waitForListen(port = E2E_PORT) {
    for (let i = 0; i < 60; i++) {
        try {
            await requestOn(port, 'GET', '/');
            return;
        } catch (_) {}
        await sleep(500);
    }
    throw new Error(`server did not listen on ${port} within 30 s`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

// A string body is sent as is (pass its Content-Type in `headers`).
function request(method, path, body, headers = {}) {
    return requestOn(E2E_PORT, method, path, body, headers);
}

function requestOn(port, method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const req = http.request(
            {
                hostname: 'localhost',
                port,
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
    const m = r.stdout.match(/Recompute ratings finish: (\d+) videos processed, (\d+) segments changed, (\d+) video_calculateds rewritten(?:, (\d+) prv_ai_video_calculateds rewritten)?/);
    assert.ok(m, `no summary line in: ${r.stdout}`);
    return { videos: Number(m[1]), segments: Number(m[2]), rewritten: Number(m[3]), ai: m[4] === undefined ? undefined : Number(m[4]) };
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

// ── AI queue: views on the read path ──────────────────────────────────────────

// The upsert runs after the response is sent, so the row is polled for.
async function waitAiVideo(nativeId, requests) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        for (let i = 0; i < 40; i++) {
            const { rows } = await c.query('SELECT * FROM prv_ai_videos WHERE native_id = $1', [nativeId]);
            if (rows[0] && rows[0].requests >= requests) return rows[0];
            await sleep(50);
        }
        return null;
    } finally {
        await c.end();
    }
}

test('ai: GET /video-calculated with views_text upserts prv_ai_videos, keeps the max count and the latest text, counts requests', async () => {
    const vid = '-1_456000101';
    assert.equal((await getCalculated('', vid, { v: '1', views_text: '500 просмотров' })).status, 204);
    let row = await waitAiVideo(vid, 1);
    assert.ok(row, 'the first request creates the row');
    assert.deepEqual([row.views_max, row.views_text, row.requests, row.status, row.attempts], [500, '500 просмотров', 1, 'seen', 0]);

    assert.equal((await getCalculated('', vid, { v: '1', views_text: '200 views' })).status, 204);
    row = await waitAiVideo(vid, 2);
    assert.deepEqual([row.views_max, row.views_text, row.requests], [500, '200 views', 2], 'a smaller count keeps the max, the text is the latest');

    assert.equal((await getCalculated('', vid, { v: '1', views_text: 'Загружается...' })).status, 204, 'an unreadable counter is no error');
    row = await waitAiVideo(vid, 3);
    assert.deepEqual([row.views_max, row.views_text], [500, 'Загружается...'], 'the unreadable text is kept for a look, the count stays');

    assert.equal((await getCalculated('', vid, { v: '1' })).status, 204);
    row = await waitAiVideo(vid, 4);
    assert.deepEqual([row.views_max, row.views_text, row.requests], [500, 'Загружается...', 4], 'a request without the counter keeps both');
    assert.ok(row.last_seen_at >= row.first_seen_at);
    assert.equal(await countVideos('', vid), 0, 'the read path still creates no Video row');

    assert.equal((await getCalculated('', vid, { v: '1', views_text: '39,4 тыс просмотров' })).status, 204);
    row = await waitAiVideo(vid, 5);
    assert.equal(row.views_max, 39400, 'an abbreviated counter reads as the count');
});

test('ai: an unreadable or missing views_text leaves views_max NULL; the legacy branch, the old views and a non-prv id write nothing', async () => {
    const vid = '-1_456000102';
    const legacy = '-1_456000103';
    assert.equal((await getCalculated('', vid, { v: '1', views_text: '1,2' })).status, 204);
    let row = await waitAiVideo(vid, 1);
    assert.deepEqual([row.views_max, row.views_text], [null, '1,2'], 'a doubtful reading sets no count (the requests fallback stays)');
    assert.equal((await getCalculated('', vid, { v: '1', views: 123 })).status, 204, 'the removed numeric views is an ignored unknown param');
    row = await waitAiVideo(vid, 2);
    assert.equal(row.views_max, null);
    const long = 'x'.repeat(300);
    assert.equal((await getCalculated('', vid, { v: '1', views_text: long })).status, 204, 'a long string is cut, not refused');
    row = await waitAiVideo(vid, 3);
    assert.equal(row.views_text, long.slice(0, 128));
    assert.equal((await getCalculated('', vid, { v: '1', views_text: '7' })).status, 204);
    assert.equal((await request('GET', `/video-calculated?video_id=${vid}&v=1&views_text=1%20%D0%BC%D0%BB%D0%BD&views_text=2%20%D0%BC%D0%BB%D0%BD`, null)).status, 204,
        'a repeated param is not a string: ignored');
    row = await waitAiVideo(vid, 5);
    assert.deepEqual([row.views_max, row.views_text], [7, '7']);

    assert.equal((await getCalculated('', legacy, { views_text: '900 просмотров' })).status, 204);
    const notPrv = '-1_456000104/../../x';
    assert.equal((await getCalculated('', notPrv, { v: '1', views_text: '900 просмотров' })).status, 204, 'served (nothing) as before');
    // A later request's row landing means the earlier ones had their chance to write.
    assert.equal((await getCalculated('', vid, { v: '1' })).status, 204);
    await waitAiVideo(vid, 6);
    assert.equal(await waitAiVideo(legacy, 1), null);
    assert.equal(await waitAiVideo(notPrv, 1), null, 'not a prv video id: never queued');
});

test('ai: the image carries the pinned yt-dlp where ai detect looks by default, under cron’s PATH', () => {
    const r = spawnSync('/usr/local/bin/yt-dlp', ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '2026.10.21');
});

test('ai: prv_ai_timelines exists with the phase-3 columns', async () => {
    const rows = await dbQuery(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'prv_ai_timelines' ORDER BY column_name`);
    assert.deepEqual(rows.map(r => [r.column_name, r.data_type, r.is_nullable]), [
        ['id', 'integer', 'NO'],
        ['measured_at', 'timestamp with time zone', 'NO'],
        ['method', 'text', 'NO'],
        ['native_id', 'character varying', 'NO'],
        ['steps', 'jsonb', 'NO'],
        ['video_id', 'integer', 'YES'],
        ['windows', 'jsonb', 'NO'],
        ['yt_duration_s', 'double precision', 'YES'],
    ]);
});

// ── AI detect (prv/commands/ai): stub yt-dlp and fixture model answers ─────────

// docker-compose.e2e.yml points YTDLP_BIN and AI_CLIENT=fixture at test/fixtures/ai; an env value of undefined drops the variable.
function runAi(args, env = {}) {
    const e = { ...process.env, DB_NAME: TEST_DB, AI_DETECT_ENABLED: 'on', ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return spawnSync(`${APP_DIR}/prv/commands/ai/ai`, args, { env: e, encoding: 'utf8', timeout: 30000 });
}

// detector.FixtureUsage (10000 in, 200 out) at the Sonnet 5.5 price; a batch pays half.
const FIXTURE_COST = 10000 * 2 / 1e6 + 200 * 10 / 1e6;

async function aiVideo(nativeId) {
    return (await dbQuery('SELECT * FROM prv_ai_videos WHERE native_id = $1', [nativeId]))[0];
}

async function aiCalculated(nativeId) {
    return (await dbQuery('SELECT * FROM prv_ai_video_calculateds WHERE native_id = $1', [nativeId]))[0] || null;
}

test('ai detect: off by default (clears a stale heartbeat); AI_CLIENT=anthropic without a key is a startup error', async () => {
    await dbQuery('DELETE FROM prv_ai_videos'); // rows from earlier tests' GETs would join this queue
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES ('-1_456000201', 50000, 1)`);
    // A command switched off after it ran must not leave a last success that ages into CalculatorStale.
    await dbQuery(`INSERT INTO calculator_heartbeats (provider, last_run_at, last_success_at, failed_videos)
        VALUES ('ai_detect', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 0)`);

    let r = runAi(['detect'], { AI_DETECT_ENABLED: undefined });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '', 'silent when off');
    assert.equal((await aiVideo('-1_456000201')).status, 'seen');
    assert.equal(await heartbeat('ai_detect'), null);

    r = runAi(['detect'], { AI_CLIENT: 'anthropic', ANTHROPIC_API_KEY: undefined });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANTHROPIC_API_KEY is not set/);
    assert.equal((await aiVideo('-1_456000201')).status, 'seen');
});

test('ai detect: queue → fetch → gate → batch → publish; heartbeat on /metrics', async () => {
    await dbQuery('DELETE FROM prv_ai_videos'); // rows from earlier tests' GETs would join this queue
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES
        ('-1_456000201', 50000, 1), ('-1_456000202', 50000, 1), ('-1_456000203', 50000, 1), ('-1_456000204', 5, 1),
        ('-1_456000205', NULL, 10), ('-1_456000206', NULL, 11), ('-1_456000208', 50000, 1)`); // 205 / 206: at and past the AI_FALLBACK_REQUESTS default
    // -1_456000208: players reported only a 900-s cut, so yt-dlp's 600.4 s is another cut.
    await dbQuery(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt") VALUES
        ('-1_456000201', 601, NOW(), NOW()), ('-1_456000201', 900, NOW(), NOW()), ('-1_456000208', 900, NOW(), NOW())`);
    const [{ id: videoId }] = await dbQuery(`SELECT id FROM videos WHERE native_id = '-1_456000201' AND duration = 601`);
    // Votes already on the bounds the detector publishes (one interval, one vote): the entry starts rated.
    await dbQuery(`INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt") VALUES
        ('detect-voter-1', $1, $2, 30, 70, 1, NOW(), NOW()), ('detect-voter-2', $1, $2, 30, 70, 1, NOW(), NOW()),
        ('detect-voter-3', $1, $2, 30, 71, 1, NOW(), NOW())`, [videoId, cats.prv.sponsor]);
    const before = Date.now() - 1000;

    const r = runAi(['detect']);
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);

    // Only the sponsor at high passes: self-promotion at medium and a 3-s sponsor are dropped.
    let v = await aiVideo('-1_456000201');
    assert.deepEqual([v.status, v.batch_id, v.last_error], ['published', null, null]);
    assert.equal(v.judge_counters, null, 'the judge owns judge_counters');
    const ai = await aiCalculated('-1_456000201');
    assert.equal(ai.video_id, videoId, 'keyed by the videos row within ±2 s of yt-dlp’s 600.4 s');
    assert.deepEqual(ai.data, [{ category_id: cats.prv.sponsor, start: 30, end: 70, confidence: 'high', source: 'ai', rating: 2 }]);
    assert.equal(ai.withdrawn_at, null);
    const [run] = await dbQuery(`SELECT * FROM prv_ai_runs WHERE native_id = '-1_456000201'`);
    assert.equal(ai.run_id, run.id);
    assert.deepEqual([run.video_id, run.model, run.prompt_version], [videoId, 'claude-sonnet-5-5', 'v2.2']);
    assert.match(run.prompt_sha, /^[0-9a-f]{64}$/);
    assert.equal(run.transcript.cues.length, 10);
    // The fixture's prv word tags are kept per cue (the review page selects by them).
    assert.deepEqual(run.transcript.cues[0].words.slice(0, 2), [{ t: 5, text: 'привет' }, { t: 5.833, text: 'всем,' }]);
    assert.ok(run.transcript.cues.every(c => c.words.length === c.text.split(/\s+/).length));
    assert.equal(run.transcript.meta.track_type, 'auto');
    assert.ok(Math.abs(run.track_overrun_s - 0.6) < 1e-9, `overrun ${run.track_overrun_s}`);
    assert.equal(run.yt_duration_s, 600.4);
    assert.equal(run.raw_output.segments.length, 3);
    assert.ok(Math.abs(run.cost_usd - FIXTURE_COST / 2) < 1e-12, `batch: half price, got ${run.cost_usd}`);
    assert.match(out, /ai detect: duration variants: -1_456000201 has 1 videos rows/);
    assert.match(out, /ai detect: -1_456000201 published: 1 entries of 3 segments/);

    v = await aiVideo('-1_456000202');
    assert.deepEqual([v.status, v.attempts], ['queued', 1], 'no ru track: retried later');
    const wait = v.next_attempt_at.getTime() - Date.now();
    assert.ok(wait > 5.9 * 3600e3 && wait <= 6 * 3600e3, `next attempt in ${wait} ms`);

    v = await aiVideo('-1_456000203');
    assert.equal(v.status, 'timeline_unreliable');
    assert.match(v.last_error, /last cue ends 10\.0 s after the video/);
    assert.equal(await aiCalculated('-1_456000203'), null);
    assert.equal(await countVideos('', '-1_456000203'), 0);
    v = await aiVideo('-1_456000208');
    assert.deepEqual([v.status, v.last_error], ['timeline_unreliable', "yt-dlp's 600 s is more than 2 s off every duration players reported"]);
    assert.equal(await aiCalculated('-1_456000208'), null);
    assert.equal(await countVideos('', '-1_456000208'), 1, 'no row for a cut no player reported');

    assert.equal((await aiVideo('-1_456000204')).status, 'seen', 'below AI_MIN_VIEWS: not taken');
    v = await aiVideo('-1_456000205');
    assert.deepEqual([v.status, v.views_max], ['seen', 120], 'fallback: yt-dlp’s view_count is below the minimum');
    v = await aiVideo('-1_456000206');
    assert.deepEqual([v.status, v.views_max], ['published', 20000], 'fallback: enough views');
    assert.deepEqual((await aiCalculated('-1_456000206')).data, [], 'nothing passed the thresholds: published empty');
    assert.equal((await dbQuery(`SELECT COUNT(*)::int AS n FROM prv_ai_runs`))[0].n, 2, 'one run per detected video');

    const hb = await heartbeat('ai_detect');
    assert.equal(hb.failed_videos, 0);
    assert.ok(hb.last_run_at.getTime() >= before, `last_run_at ${hb.last_run_at}`);
    assert.match(await fetchMetrics(), /^calculator_last_success_timestamp_seconds\{provider="ai_detect"\} \d/m);
});

test('import-below-threshold: the dropped segments become sheet items once, never AI items', async () => {
    const run = (...args) => spawnSync('node', [`${APP_DIR}/scripts/import-below-threshold.js`, ...args],
        { env: { ...process.env, DB_NAME: TEST_DB }, encoding: 'utf8', timeout: 30000 });
    // -1_456000201: self_promotion at medium (300–320) and a 3-s sponsor (480–483) were dropped; -1_456000206 published empty.
    let r = run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^2 segments below the threshold and at least 5 s, 2 not yet in review \(2 videos\)\nB1\t-1_456000201\t300\t320\tself_promotion\t.*\nB2\t-1_456000206\t20\t30\tsponsor\t/, 'the 3-s sponsor is under the floor');
    r = run('--dry-run', '--min-seconds', '0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^3 segments below the threshold and at least 0 s, 3 not yet in review \(2 videos\)\n/);
    assert.equal((await dbQuery(`SELECT COUNT(*)::int AS n FROM prv_review_items WHERE native_id LIKE '-1_45600020%'`))[0].n, 0, 'dry run writes nothing');

    r = run('--sheet', 'below-test', '--empty-only', '--min-seconds', '0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /imported 1 items into below-test \(1\)/);
    let items = await dbQuery(`SELECT * FROM prv_review_items WHERE sheet = 'below-test' ORDER BY position`);
    assert.deepEqual(items.map((i) => [i.sheet, i.batch, i.item_code, i.native_id, i.proposed, i.kind, i.video_id]),
        [['below-test', 'below-test', 'B1', '-1_456000206', 'sponsor', 'sheet', null]]);
    assert.deepEqual((await dbQuery(`SELECT reviews_needed, priority, locked_by FROM prv_review_batches WHERE batch = 'below-test'`))[0],
        { reviews_needed: 1, priority: 'optional', locked_by: null });

    r = run('--sheet', 'below-test');
    assert.equal(r.status, 1, 'a sheet with items is refused');
    assert.match(r.stderr, /sheet below-test already has items/);

    r = run('--sheet', 'below-test-2', '--max-items', '1', '--priority', 'important', '--min-seconds', '0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^3 segments below the threshold and at least 0 s, 2 not yet in review \(1 videos\)\nimported 2 items into below-test-2-p1 \(1\), below-test-2-p2 \(1\)/);
    items = await dbQuery(`SELECT * FROM prv_review_items WHERE sheet = 'below-test-2' ORDER BY position`);
    assert.deepEqual(items.map((i) => [i.batch, i.item_code, i.native_id, i.start, i.end, i.proposed, i.link, i.cues]), [
        ['below-test-2-p1', 'B1', '-1_456000201', 300, 320, 'self_promotion', 'https://example.invalid/video-1_456000201?t=4m58s', 'подписывайтесь на мой телеграм канал\nтам ролики выходят раньше'],
        ['below-test-2-p2', 'B2', '-1_456000201', 480, 483, 'sponsor', 'https://example.invalid/video-1_456000201?t=7m58s', 'промокод ещё раз в описании'],
    ]);
    assert.match(items[0].flagged_by[0], /^detect run \d+: self_promotion medium, 20 s, below the publish threshold$/);

    r = run('--sheet', 'below-test-3', '--min-seconds', '0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '3 segments below the threshold and at least 0 s, 0 not yet in review (0 videos)\n');
    await dbQuery(`DELETE FROM prv_review_items WHERE sheet LIKE 'below-test%'`);
    await dbQuery(`DELETE FROM prv_review_batches WHERE batch LIKE 'below-test%'`);
});

test('ai detect <native_id>: the manual run ignores views and the switch, calls the model synchronously, writes no heartbeat; a video with an AI row is never re-detected', async () => {
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES ('-1_456000204', 5, 1) ON CONFLICT DO NOTHING`);
    const hb = await heartbeat('ai_detect');
    const r = runAi(['detect', '-1_456000204'], { AI_DETECT_ENABLED: undefined });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /batch .* submitted/, 'no batch: nothing waits for a cron tick');
    const v = await aiVideo('-1_456000204');
    assert.deepEqual([v.status, v.batch_id], ['published', null]);
    const ai = await aiCalculated('-1_456000204');
    assert.deepEqual(ai.data, [{ category_id: cats.prv.self_promotion, start: 20, end: 45, confidence: 'high', source: 'ai' }]);
    const [run] = await dbQuery(`SELECT cost_usd, transcript FROM prv_ai_runs WHERE native_id = '-1_456000204'`);
    assert.ok(Math.abs(run.cost_usd - FIXTURE_COST) < 1e-12, `synchronous: full price, got ${run.cost_usd}`);
    assert.ok(run.transcript.cues.length > 0 && run.transcript.cues.every(c => !('words' in c)), 'a track without word tags stores no words');
    const videos = await dbQuery(`SELECT id, duration FROM videos WHERE native_id = '-1_456000204'`);
    assert.deepEqual(videos, [{ id: ai.video_id, duration: 300 }]);
    assert.deepEqual(await heartbeat('ai_detect'), hb);

    // Votes, review verdicts and withdrawals refer to the AI row: a re-detect would replace it under them.
    for (const status of ['published', 'withdrawn']) {
        await dbQuery(`UPDATE prv_ai_videos SET status = $1 WHERE native_id = '-1_456000204'`, [status]);
        const again = runAi(['detect', '-1_456000204']);
        assert.equal(again.status, 1);
        assert.match(again.stderr, new RegExp(`-1_456000204 already has an AI row \\(status ${status}\\): a re-detect is not supported`));
    }
    await dbQuery(`UPDATE prv_ai_videos SET status = 'detecting' WHERE native_id = '-1_456000204'`);
    const busy = runAi(['detect', '-1_456000204']);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /-1_456000204 is already being fetched or detected/);
    await dbQuery(`UPDATE prv_ai_videos SET status = 'published' WHERE native_id = '-1_456000204'`);
    assert.equal((await dbQuery(`SELECT COUNT(*)::int AS n FROM prv_ai_runs WHERE native_id = '-1_456000204'`))[0].n, 1);

    // No model answer (the fixture is missing): failed, the run row kept, exit 1 with the reason.
    const failed = runAi(['detect', '-1_456000209']);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /-1_456000209 failed: fixture: .*no such file/);
    const f = await aiVideo('-1_456000209');
    assert.equal(f.status, 'failed');
    assert.match(f.last_error, /fixture: .*-1_456000209\.detect\.json/);
    const [frun] = await dbQuery(`SELECT raw_output FROM prv_ai_runs WHERE native_id = '-1_456000209'`);
    assert.equal(frun.raw_output, null);
    assert.equal(await aiCalculated('-1_456000209'), null);

    // An interrupted run left `fetching`: refused while fresh, claimed again after an hour (the cron may be off).
    await dbQuery(`UPDATE prv_ai_videos SET status = 'fetching', updated_at = NOW() WHERE native_id = '-1_456000209'`);
    assert.match(runAi(['detect', '-1_456000209']).stderr, /-1_456000209 is already being fetched or detected/);
    await dbQuery(`UPDATE prv_ai_videos SET updated_at = NOW() - INTERVAL '61 minutes' WHERE native_id = '-1_456000209'`);
    const stale = runAi(['detect', '-1_456000209']);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /-1_456000209 failed: fixture: .*no such file/);
    assert.equal((await aiVideo('-1_456000209')).status, 'failed');
});

test('ai detect: a yt-dlp failure is the video’s (retried later, not a failed tick); a yt-dlp that cannot start is the tick’s', async () => {
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES ('-1_456000207', 50000, 1)`);
    let r = runAi(['detect']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /ai detect: -1_456000207 queued after fetch attempt 1: .*This video is unavailable/);
    const v = await aiVideo('-1_456000207');
    assert.deepEqual([v.status, v.attempts], ['queued', 1]);
    assert.match(v.last_error, /This video is unavailable/);
    let hb = await heartbeat('ai_detect');
    assert.equal(hb.failed_videos, 0);
    assert.equal(hb.last_success_at.getTime(), hb.last_run_at.getTime());

    await dbQuery(`UPDATE prv_ai_videos SET next_attempt_at = NOW() WHERE native_id = '-1_456000207'`);
    r = runAi(['detect'], { YTDLP_BIN: '/nonexistent/yt-dlp' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /ai detect: -1_456000207 [\s\S]*no such file or directory/);
    const w = await aiVideo('-1_456000207');
    assert.deepEqual([w.status, w.attempts], ['fetching', 1], 'no attempt spent: claimed again after an hour');
    hb = await heartbeat('ai_detect');
    assert.equal(hb.failed_videos, 1);
    assert.equal(hb.last_success_at.getTime(), hb.last_run_at.getTime(), 'the tick itself ran: CalculatorFailedVideos, not CalculatorStale');
    await dbQuery(`UPDATE prv_ai_videos SET status = 'queued', next_attempt_at = NOW() + INTERVAL '1 day' WHERE native_id = '-1_456000207'`);
});

test('ai detect: a tick whose every fetch fails while a published video still fetches is the videos’: attempts spent, no failed tick', async () => {
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES ('-1_456000214', 50000, 1), ('-1_456000215', 50000, 1)`);
    const r = runAi(['detect']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /ai detect: every fetch of the tick failed, control video \S+ did not/);
    assert.doesNotMatch(r.stderr, /prv may be refusing the host/);
    for (const id of ['-1_456000214', '-1_456000215']) {
        const v = await aiVideo(id);
        assert.deepEqual([v.status, v.attempts], ['queued', 1]);
    }
    assert.equal((await heartbeat('ai_detect')).failed_videos, 0);
    await dbQuery(`UPDATE prv_ai_videos SET status = 'failed' WHERE native_id IN ('-1_456000214', '-1_456000215')`);
});

test('ai detect: a tick whose every fetch fails, the control video’s too, is the host’s (prv refusing it): failed videos, no attempt spent', async () => {
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES ('-1_456000212', 50000, 1), ('-1_456000213', 50000, 1)`);
    const r = runAi(['detect'], { YTDLP_STUB_REFUSE: '1' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /ai detect: control video \S+ failed too/);
    assert.match(r.stderr, /ai detect: every fetch of the tick failed \(2 videos\)/);
    for (const id of ['-1_456000212', '-1_456000213']) {
        const v = await aiVideo(id);
        assert.deepEqual([v.status, v.attempts], ['fetching', 0], 'claimed again after an hour');
    }
    const hb = await heartbeat('ai_detect');
    assert.equal(hb.failed_videos, 2);
    assert.equal(hb.last_success_at.getTime(), hb.last_run_at.getTime(), 'CalculatorFailedVideos, not CalculatorStale');
    await dbQuery(`UPDATE prv_ai_videos SET status = 'failed' WHERE native_id IN ('-1_456000212', '-1_456000213')`);
});

test('ai detect: a run with no model result after 24 h fails, also while the switch is off', async () => {
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, status, batch_id, updated_at) VALUES
        ('-1_456000210', 'detecting', 'msgbatch_lost', NOW() - INTERVAL '25 hours'), ('-1_456000211', 'detecting', NULL, NOW() - INTERVAL '23 hours')`);
    const r = runAi(['detect'], { AI_DETECT_ENABLED: undefined });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /ai detect: -1_456000210 failed: no model result after 24 h/);
    assert.deepEqual([(await aiVideo('-1_456000210')).status, (await aiVideo('-1_456000210')).last_error], ['failed', 'no model result after 24 h']);
    assert.equal((await aiVideo('-1_456000211')).status, 'detecting');
    await dbQuery(`DELETE FROM prv_ai_videos WHERE native_id IN ('-1_456000210', '-1_456000211')`);
});

// ── AI-first serving (lib/find-ai-calculated.js): AI_FIRST is read at boot ──
// The main app runs with the default (off); a second app on AI_PORT runs with AI_FIRST=on against the same DB.

const AI_PORT = 3098;

async function aiFirstServer() {
    if (!aiFirstProc) {
        aiFirstProc = startServer(AI_PORT, { AI_FIRST: 'on' }, 'ai-first');
        await waitForListen(AI_PORT);
    }
}

// A human segment (sponsor 100–120 from one markup) and a published AI row (sponsor 30–70) on the same videos row.
async function aiFirstVideo(nativeId) {
    await postMarkup('', { video_id: nativeId, v: '1', user_id: `${nativeId}-author`, category_id: cats.prv.sponsor,
        duration: 600, data: { intervals: [{ start: 100, end: 120 }] } });
    runCalc('prv');
    const videoId = await prvVideoId(nativeId);
    const [run] = await dbQuery(
        `INSERT INTO prv_ai_runs (native_id, video_id, prompt_sha, prompt_version, model, transcript, track_overrun_s, yt_duration_s)
         VALUES ($1, $2, 'sha', 'v2.2', 'claude-sonnet-5-5', '{}', 0, 600) RETURNING id`, [nativeId, videoId]);
    const data = [{ category_id: cats.prv.sponsor, start: 30, end: 70, confidence: 'high', source: 'ai' }];
    await dbQuery(`INSERT INTO prv_ai_video_calculateds (video_id, native_id, run_id, data) VALUES ($1, $2, $3, $4)`,
        [videoId, nativeId, run.id, JSON.stringify(data)]);
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, status) VALUES ($1, 'published')
        ON CONFLICT (native_id) DO UPDATE SET status = 'published'`, [nativeId]);
    return { videoId, ai: data, human: [{ category_id: cats.prv.sponsor, start: 100, end: 120 }] };
}

async function aiData(videoId) {
    return (await dbQuery(`SELECT data FROM prv_ai_video_calculateds WHERE video_id = $1`, [videoId]))[0].data;
}

function getCalculatedOn(port, videoId, extra = {}) {
    return requestOn(port, 'GET', `/video-calculated?${new URLSearchParams({ video_id: videoId, ...extra })}`);
}

test('ai-first: the AI row is served over video_calculateds with AI_FIRST=on, the human one with the default', async () => {
    await aiFirstServer();
    const vid = '-1_456000301';
    const { ai, human } = await aiFirstVideo(vid);

    const lookup = async () => parseCounter(
        (await requestOn(AI_PORT, 'GET', '/metrics')).body, 'video_calculated_lookup_total',
        { outcome: 'match', provider: 'prv', source: 'ai' });
    const before = await lookup();
    let res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 601 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, ai);
    assert.equal(await lookup() - before, 1, 'counted with source="ai"');

    res = await getCalculated('', vid, { v: '1', duration: 601 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map(({ category_id, start, end }) => ({ category_id, start, end })), human);
    assert.match(await fetchMetrics(), /video_calculated_lookup_total\{outcome="match",provider="prv",source="human"\} [1-9]/);

    res = await getCalculatedOn(AI_PORT, vid, { duration: 601 });
    assert.deepEqual(res.body.map(({ start }) => start), [100], 'the legacy branch (no v) stays human');

    // The AI row is timed for the 600-s cut: a player off by more than 2 s, or one without a duration, may be on another cut.
    for (const extra of [{ duration: 605 }, {}]) {
        res = await getCalculatedOn(AI_PORT, vid, { v: '1', ...extra });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.map(({ start }) => start), [100], `human path for ${JSON.stringify(extra)}`);
    }
});

test('ai-first: votes on AI entries rate the AI row; a human segment of the video is 404; vote delete is symmetric', async () => {
    await aiFirstServer();
    const vid = '-1_456000302';
    const { videoId } = await aiFirstVideo(vid);
    const author = `${vid}-author`;
    const authorBefore = await userRating('', author);
    const vote = (port, userId, start, end, value) => requestOn(port, 'POST', '/vote', {
        video_id: vid, user_id: userId, category_id: cats.prv.sponsor, start, end, vote: value, duration: 600 });

    assert.equal((await vote(AI_PORT, 'ai-voter-1', 30, 70, 1)).status, 204);
    assert.equal((await vote(AI_PORT, 'ai-voter-2', 30, 70, 1)).status, 204);
    assert.equal((await aiData(videoId))[0].rating, 2);
    assert.equal((await vote(AI_PORT, 'ai-voter-2', 30, 70, -1)).status, 204, 'a changed vote replaces the earlier one');
    assert.equal((await aiData(videoId))[0].rating, undefined, '1 − 1 = 0: rating omitted');
    assert.equal(await userRating('', author), authorBefore, 'no markup author has the AI bounds');

    assert.equal((await vote(AI_PORT, 'ai-voter-1', 100, 120, 1)).status, 404, 'not served, so not votable');
    assert.equal(await getJsonRating('', vid, cats.prv.sponsor, 100, 120), 0);
    assert.equal((await vote(E2E_PORT, 'ai-voter-1', 30, 70, 1)).status, 404, 'AI_FIRST off: the AI entry is not served');
    assert.equal((await vote(E2E_PORT, 'ai-voter-1', 100, 120, 1)).status, 204, 'AI_FIRST off: the human path as before');
    assert.equal(await getJsonRating('', vid, cats.prv.sponsor, 100, 120), 1);
    assert.equal(await userRating('', author), authorBefore + 1);

    const del = async userId => {
        const [{ id }] = await dbQuery(`SELECT id FROM votes WHERE user_id = $1 AND video_id = $2 AND start = 30`, [userId, videoId]);
        return requestOn(AI_PORT, 'GET', `/votes/${id}/delete?verifyBearerToken=${VOTE_AUTH}`);
    };
    assert.equal((await del('ai-voter-2')).status, 201);
    assert.equal((await aiData(videoId))[0].rating, 1, 'without voter 2’s −1');
    assert.equal(await getJsonRating('', vid, cats.prv.sponsor, 100, 120), 1, 'the human segment is untouched');
});

test('ai-first: one interval, one vote: an AI-path vote on the bounds of a human interval rates its author and both segments; its delete reverses both', async () => {
    await aiFirstServer();
    const vid = '-1_456000304';
    const { videoId } = await aiFirstVideo(vid);
    const twin = `${vid}-twin`;
    await postMarkup('', { video_id: vid, v: '1', user_id: twin, category_id: cats.prv.sponsor,
        duration: 600, data: { intervals: [{ start: 30, end: 70 }] } });
    runCalc('prv');
    const before = await userRating('', twin);
    const vote = (userId, value, extra = { duration: 600 }) => requestOn(AI_PORT, 'POST', '/vote', {
        video_id: vid, user_id: userId, category_id: cats.prv.sponsor, start: 30, end: 70, vote: value, ...extra });
    const ratings = async () => [(await aiData(videoId))[0].rating, await getJsonRating('', vid, cats.prv.sponsor, 30, 70),
        (await getSegmentRow('', vid, cats.prv.sponsor, 30, 70)).rating];

    assert.equal((await vote('twin-voter-1', -1)).status, 204);
    assert.deepEqual(await ratings(), [-1, -1, -1], 'AI entry, human JSON entry and segment row');
    assert.equal(await userRating('', twin), before - 1, 'the AI path rates the interval’s author');
    const [{ id }] = await dbQuery(`SELECT id FROM votes WHERE user_id = 'twin-voter-1'`);
    assert.equal((await requestOn(AI_PORT, 'GET', `/votes/${id}/delete?verifyBearerToken=${VOTE_AUTH}`)).status, 201);
    assert.equal(await userRating('', twin), before, 'the delete reverses it');
    assert.deepEqual(await ratings(), [undefined, 0, 0]);

    // Without a duration GET serves the human row (`no_duration`): same interval, same effect.
    assert.equal((await vote('twin-voter-2', 1, {})).status, 204);
    assert.deepEqual(await ratings(), [1, 1, 1]);
    assert.equal(await userRating('', twin), before + 1);
});

test('ai-first: --recompute-ratings rewrites the ratings of AI rows, withdrawn ones too, from the votes (prv only)', async () => {
    await aiFirstServer();
    const vid = '-1_456000306';
    const { videoId } = await aiFirstVideo(vid);
    const res = await requestOn(AI_PORT, 'POST', '/vote', { video_id: vid, user_id: 'recompute-ai-voter', category_id: cats.prv.sponsor,
        start: 30, end: 70, vote: 1, duration: 600 });
    assert.equal(res.status, 204);
    await dbQuery(`UPDATE prv_ai_video_calculateds SET data = jsonb_set(data, '{0,rating}', '5'), withdrawn_at = NOW(), withdrawn_by = 'admin'
        WHERE video_id = $1`, [videoId]);

    const first = runRecomputeRatings('prv');
    assert.ok(first.ai >= 1, `AI rows rewritten: ${first.ai}`);
    assert.deepEqual((await aiData(videoId)).map(e => e.rating), [1]);
    assert.equal(runRecomputeRatings('prv').ai, 0, 'a second run changes nothing');
    assert.equal(runRecomputeRatings('rt').ai, undefined, 'AI rows are prv only');
});

test('ai-first: a videos row without a duration is backfilled by the player’s and its AI row served', async () => {
    await aiFirstServer();
    const vid = '-1_456000305';
    const { videoId, data } = await aiPublished(vid);
    await dbQuery(`UPDATE videos SET duration = NULL WHERE id = $1`, [videoId]);
    const lookup = async () => parseCounter((await requestOn(AI_PORT, 'GET', '/metrics')).body, 'video_calculated_lookup_total',
        { outcome: 'backfilled', provider: 'prv', source: 'ai' });
    const before = await lookup();
    const res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 601 });
    assert.deepEqual([res.status, res.body], [200, data]);
    assert.equal((await dbQuery(`SELECT duration FROM videos WHERE id = $1`, [videoId]))[0].duration, 601);
    assert.equal(await lookup() - before, 1);
});

test('ai-first: the admin withdraw link unpublishes the AI row and the human path is served again', async () => {
    await aiFirstServer();
    const vid = '-1_456000303';
    const { videoId, human } = await aiFirstVideo(vid);
    const page = async () => (await requestOn(AI_PORT, 'GET', `/admin/video/${videoId}?verifyBearerToken=${VOTE_AUTH}`)).body;
    const withdraw = token => requestOn(AI_PORT, 'GET', `/admin/video/${videoId}/ai/withdraw?verifyBearerToken=${token}`);

    let html = await page();
    assert.match(html, /<h2>AI<\/h2>/);
    assert.match(html, /Status: <strong>published<\/strong>/);
    assert.match(html, /Served: <strong id="ai-served">yes<\/strong>/);
    assert.match(html, /withdrawAi\(this\)/);
    assert.match(html, /data-start="30" data-end="70"/);
    assert.doesNotMatch(await (await requestOn(AI_PORT, 'GET', `/admin/video/${await prvVideoId('__e2e__prv_basic')}?verifyBearerToken=${VOTE_AUTH}`)).body,
        /<h2>AI<\/h2>/, 'no AI block for a video the detector never saw');

    assert.equal((await withdraw('wrong')).status, 401);
    assert.equal((await requestOn(AI_PORT, 'GET', `/admin/video/abc/ai/withdraw?verifyBearerToken=${VOTE_AUTH}`)).status, 400);
    assert.equal((await withdraw(VOTE_AUTH)).status, 200);
    const [row] = await dbQuery(`SELECT * FROM prv_ai_video_calculateds WHERE video_id = $1`, [videoId]);
    assert.ok(row.withdrawn_at);
    assert.deepEqual([row.withdrawn_by, row.withdrawn_reason, row.data.length], ['admin', 'withdrawn on /admin/video', 1]);
    assert.equal((await aiVideo(vid)).status, 'withdrawn');
    assert.equal((await withdraw(VOTE_AUTH)).status, 404, 'already withdrawn');

    const res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600 });
    assert.deepEqual(res.body.map(({ category_id, start, end }) => ({ category_id, start, end })), human);
    html = await page();
    assert.match(html, /withdrawn \d{4}-\d\d-\d\d [\d:]+ by admin: withdrawn on \/admin\/video/);
    assert.match(html, /Served: <strong id="ai-served">no<\/strong>/);
    assert.doesNotMatch(html, /withdrawAi\(this\)/);

    await dbQuery(`UPDATE prv_ai_video_calculateds SET withdrawn_reason = '<i>r</i>' WHERE video_id = $1`, [videoId]);
    await dbQuery(`UPDATE prv_ai_videos SET last_error = '<b>e</b>' WHERE native_id = $1`, [vid]);
    html = await page();
    assert.ok(html.includes('by admin: &lt;i&gt;r&lt;/i&gt;') && html.includes('Last error: &lt;b&gt;e&lt;/b&gt;'), 'escaped');
    assert.ok(!html.includes('<i>r</i>') && !html.includes('<b>e</b>'));
});

// ── AI judge (ai/judge): signals, rules, the fixture LLM judge (test/fixtures/ai/<native_id>.judge.json) ──

const AI_TRANSCRIPT = { meta: {}, cues: [
    { start: 28, end: 33, text: 'Этот выпуск спонсирует сервис' },
    { start: 33, end: 40, text: 'переходите по ссылке в описании' },
    { start: 300, end: 305, text: 'далее по теме' },
] };

// A published AI row (sponsor 30–70 unless `data` says otherwise) on a 600-s videos row, published `hoursAgo`
// (the judge waits 24 h for a first judgement).
async function aiPublished(nativeId, hoursAgo = 25,
    data = [{ category_id: cats.prv.sponsor, start: 30, end: 70, confidence: 'high', source: 'ai' }]) {
    const [{ id: videoId }] = await dbQuery(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt")
        VALUES ($1, 600, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days') RETURNING id`, [nativeId]);
    const [run] = await dbQuery(
        `INSERT INTO prv_ai_runs (native_id, video_id, prompt_sha, prompt_version, model, transcript, track_overrun_s, yt_duration_s)
         VALUES ($1, $2, 'sha', 'v2.2', 'claude-sonnet-5-5', $3, 0, 600) RETURNING id`, [nativeId, videoId, JSON.stringify(AI_TRANSCRIPT)]);
    await dbQuery(`INSERT INTO prv_ai_video_calculateds (video_id, native_id, run_id, data, published_at)
        VALUES ($1, $2, $3, $4, NOW() - make_interval(hours => $5))`, [videoId, nativeId, run.id, JSON.stringify(data), hoursAgo]);
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, status, requests) VALUES ($1, 'published', 1)`, [nativeId]);
    return { videoId, data };
}

async function postUndo(nativeId, userId, start, end) {
    const res = await request('POST', '/events', [{ type: 'interval_undo', user_id: userId, video_native_id: nativeId,
        category_id: cats.prv.sponsor, start, end }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function judgements(videoId) {
    return dbQuery(`SELECT decision, "by", reason, signals, model, cost_usd FROM prv_ai_judgements WHERE video_id = $1 ORDER BY id`, [videoId]);
}

async function aiItems(videoId) {
    return dbQuery(`SELECT * FROM prv_review_items WHERE video_id = $1 ORDER BY id`, [videoId]);
}

const fixtureReason = nativeId => JSON.parse(fs.readFileSync(path.join(APP_DIR, 'test/fixtures/ai', `${nativeId}.judge.json`), 'utf8')).reason;

test('ai judge: off by default; no signal → ok by rules, an undo → the LLM says review (items, row served); not due before 24 h; one LLM call per interval', async () => {
    const quiet = await aiPublished('-1_456000401');
    const undone = await aiPublished('-1_456000402');
    const fresh = await aiPublished('-1_456000403', 1);
    await postUndo('-1_456000402', 'judge-u1', 30, 70);
    await postUndo('-1_456000402', 'judge-u1', 100, 120); // not an AI entry's bounds
    await postUndo('-1_456000403', 'judge-u1', 30, 70);

    await dbQuery(`INSERT INTO calculator_heartbeats (provider, last_run_at, last_success_at, failed_videos)
        VALUES ('ai_judge', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 0)`);
    let r = runAi(['judge']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '', 'silent when off');
    assert.equal(await heartbeat('ai_judge'), null, 'off clears the heartbeat');
    assert.doesNotMatch(await fetchMetrics(), /provider="ai_judge"/);
    assert.deepEqual(await judgements(undone.videoId), []);

    const before = Date.now() - 1000;
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    const out = r.stdout + r.stderr;
    assert.equal(r.status, 0, out);

    let [j] = await judgements(quiet.videoId);
    assert.deepEqual([j.decision, j.by, j.reason, j.model, j.cost_usd], ['ok', 'rules', 'no negative signal', null, null]);
    const js = await judgements(undone.videoId);
    assert.equal(js.length, 1);
    const reason = fixtureReason('-1_456000402');
    assert.deepEqual([js[0].decision, js[0].by, js[0].reason, js[0].model, js[0].cost_usd], ['review', 'llm', reason, 'claude-sonnet-5-5', FIXTURE_COST]);
    assert.deepEqual([js[0].signals.undo, js[0].signals.votes_down, js[0].signals.requests], [1, 0, 1]);
    assert.ok(js[0].signals.age_h > 24.9 && js[0].signals.age_h < 25.5, `age_h ${js[0].signals.age_h}`);
    assert.match(out, new RegExp(`ai judge: ${undone.videoId} review llm: `));
    assert.deepEqual(await judgements(fresh.videoId), [], 'published 1 h ago: not due');
    assert.deepEqual(await aiItems(quiet.videoId), [], 'ok: nobody is asked');

    let items = await aiItems(undone.videoId);
    assert.equal(items.length, 1);
    const [it] = items;
    assert.match(it.batch, /^ai-judge-\d{4}-\d\d-\d\d$/);
    assert.deepEqual(await dbQuery('SELECT priority FROM prv_review_batches WHERE batch = $1', [it.batch]), [{ priority: 'urgent' }], 'judge batches are urgent');
    assert.deepEqual([it.sheet, it.kind, it.item_code, it.native_id, it.start, it.end, it.proposed],
        [it.batch, 'ai', 'A1', '-1_456000402', 30, 70, 'sponsor']);
    assert.equal(it.cues, 'Этот выпуск спонсирует сервис\nпереходите по ссылке в описании');
    assert.equal(it.link, 'https://example.invalid/video-1_456000402?t=28s');
    assert.deepEqual(it.flagged_by, [`judge review by llm: ${reason}`, 'signals: undo=1', 'keep: true']);
    assert.match(out, new RegExp(`ai judge: ${undone.videoId} sent 1 items to review batch ${it.batch}`));

    const v = await aiVideo('-1_456000402');
    assert.ok(v.judged_at);
    assert.deepEqual([v.status, v.judge_counters.undo, v.judge_counters.duration_recut], ['published', 1, 0]);
    assert.equal((await aiCalculated('-1_456000402')).withdrawn_at, null, 'review keeps the row served');
    const hb = await heartbeat('ai_judge');
    assert.equal(hb.failed_videos, 0);
    assert.ok(hb.last_run_at.getTime() >= before);
    assert.match(await fetchMetrics(), /^calculator_last_success_timestamp_seconds\{provider="ai_judge"\} \d/m);

    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await judgements(undone.videoId)).length, 1, 'counters unchanged: not judged again');
    assert.equal((await judgements(quiet.videoId)).length, 1);

    await postUndo('-1_456000402', 'judge-u2', 30, 70);
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await judgements(undone.videoId)).length, 1, 'counters moved, but the last LLM call is within AI_JUDGE_MIN_INTERVAL');
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on', AI_JUDGE_MIN_INTERVAL: '0' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    [, j] = await judgements(undone.videoId);
    assert.deepEqual([j.decision, j.by, j.signals.undo], ['review', 'llm', 2]);
    assert.match(r.stdout + r.stderr, new RegExp(`ai judge: ${undone.videoId} already waits for a review verdict on every entry, no new items`));
    assert.equal((await aiItems(undone.videoId)).length, 1, 'no duplicate item while one is open');
    assert.equal((await judgements(quiet.videoId)).length, 1);

    const html = (await request('GET', `/admin/video/${undone.videoId}?verifyBearerToken=${VOTE_AUTH}`)).body;
    assert.equal((html.match(/class="ai-judgement"/g) || []).length, 2);
    assert.match(html, /<td><strong>review<\/strong><\/td>\s*<td>llm<\/td>/);
});

test('ai judge: the fixture LLM says ok on a conflicting markup → nothing changes; a videos row of another cut requested after publish goes to review, the row stays served to its own cut', async () => {
    await aiFirstServer();
    const vid = '-1_456000404';
    const { videoId, data } = await aiPublished(vid);
    await postMarkup('', { video_id: vid, v: '1', user_id: 'judge-human', category_id: cats.prv.sponsor,
        duration: 600, data: { intervals: [{ start: 100, end: 120 }] } });
    runCalc('prv');
    let res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600 });
    assert.deepEqual(res.body, data);
    await waitAiVideo(vid, 2);

    // A user marks the re-cut: a new videos row, but no request for the video since.
    await postMarkup('', { video_id: vid, v: '1', user_id: 'judge-recut', category_id: cats.prv.sponsor,
        duration: 900, data: { intervals: [{ start: 10, end: 40 }] } });
    runCalc('prv');
    assert.equal(await countVideos('', vid), 2);
    let r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let [j] = await judgements(videoId);
    assert.deepEqual([j.decision, j.by, j.reason], ['ok', 'llm', fixtureReason(vid)], 'the 100–120 sponsor disagrees: the LLM decides');
    assert.deepEqual([j.signals.conflicting_markups, j.signals.duration_variants, j.signals.duration_recut], [1, 1, 0]);
    assert.equal((await aiCalculated(vid)).withdrawn_at, null);
    assert.deepEqual(await aiItems(videoId), []);

    // Anyone can create a videos row with any duration: a re-cut goes to a human, it never withdraws on its own.
    await getCalculated('', vid, { v: '1', duration: 900 });
    await waitAiVideo(vid, 3);
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    [, j] = await judgements(videoId);
    assert.deepEqual([j.decision, j.by, j.reason], ['review', 'rules', 'duration: 1 videos rows of another cut requested after publish']);
    assert.equal((await aiCalculated(vid)).withdrawn_at, null);
    assert.equal((await aiVideo(vid)).status, 'published');
    const [it] = await aiItems(videoId);
    assert.deepEqual([it.kind, it.start, it.end, it.cues], ['ai', 30, 70, 'Этот выпуск спонсирует сервис\nпереходите по ссылке в описании']);
    assert.deepEqual(it.flagged_by, [`judge review by rules: ${j.reason}`, 'signals: conflicting_markups=1 duration_recut=1']);

    res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600 });
    assert.deepEqual(res.body, data, 'served to the 600-s cut it was timed for');
    res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 900 });
    assert.deepEqual(res.body.map(({ start, end }) => [start, end]), [[10, 40]], 'the new cut gets its own human path');
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal((await judgements(videoId)).length, 2, 'nothing new: not judged again');
});

test('ai judge: the fixture LLM says withdraw → the row is withdrawn, the human path served, the items are on /admin/review', async () => {
    await aiFirstServer();
    const vid = '-1_456000405';
    const { videoId } = await aiPublished(vid);
    await postMarkup('', { video_id: vid, v: '1', user_id: 'judge-human-405', category_id: cats.prv.sponsor,
        duration: 600, data: { intervals: [{ start: 100, end: 120 }] } });
    runCalc('prv');
    await postUndo(vid, 'judge-u1', 30, 70);
    await postUndo(vid, 'judge-u2', 30, 70);

    const r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const reason = fixtureReason(vid);
    const [j] = await judgements(videoId);
    assert.deepEqual([j.decision, j.by, j.reason], ['withdraw', 'llm', reason]);
    const row = await aiCalculated(vid);
    assert.ok(row.withdrawn_at);
    assert.deepEqual([row.withdrawn_by, row.withdrawn_reason, row.data.length], ['judge', reason, 1]);
    assert.equal((await aiVideo(vid)).status, 'withdrawn');
    const res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600 });
    assert.deepEqual(res.body.map(({ start, end }) => [start, end]), [[100, 120]], 'the human path');

    const [it] = await aiItems(videoId);
    assert.deepEqual([it.kind, it.proposed], ['ai', 'sponsor']);
    assert.match(it.item_code, /^A\d+$/, 'the next code of the day’s sheet');
    const q = `reviewer=bayanovea&verifyBearerToken=${MOD_AUTH}`;
    const list = await request('GET', `/admin/review?format=json&${q}`, null);
    assert.equal(list.status, 200);
    const b = list.body.batches.find(x => x.batch === it.batch);
    const [{ total }] = await dbQuery(`SELECT COUNT(*)::int AS total FROM prv_review_items WHERE batch = $1`, [it.batch]);
    assert.deepEqual([b.total, b.decided, b.state, b.reviews_needed], [total, 0, 'available', 1]);

    const page = await request('GET', `/admin/review/${encodeURIComponent(it.batch)}?item=${it.item_code}&format=json&${q}`, null);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual([page.body.item.kind, page.body.item.video_id, page.body.item.native_id, page.body.item.cues],
        ['ai', videoId, vid, it.cues]);
    assert.equal(page.body.item.player_link, 'https://example.invalid/video-1_456000405?t=28s');
    assert.equal(page.body.item.flagged_by, undefined, 'blind until decided');
    assert.ok(page.body.signals.markups.some(m => m.start === 100 && m.end === 120), 'the signals panel shows the human markup');
    const html = await request('GET', `/admin/review/${encodeURIComponent(it.batch)}?item=${it.item_code}&${q}`, null);
    assert.equal(html.status, 200);
    assert.ok(html.body.includes('переходите по ссылке в описании'));
    assert.ok(!html.body.includes(reason), 'the judge’s reason is blind too');
});

// ── Review verdicts applied to the AI row (aiRepository.applyVerdict via POST /admin/review/decide) ──

// An AI row with sponsor `entries` ([start, end]) on a 600-s videos row, withdrawn an hour ago by `withdrawnBy`
// (null: served), and one kind='ai' item per entry in `batch` (codes from A`firstPos`), flagged by the judge.
async function aiReviewSeed(nativeId, batch, entries, { withdrawnBy = null, firstPos = 1 } = {}) {
    const [{ id: videoId }] = await dbQuery(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt")
        VALUES ($1, 600, NOW(), NOW()) RETURNING id`, [nativeId]);
    const [run] = await dbQuery(
        `INSERT INTO prv_ai_runs (native_id, video_id, prompt_sha, prompt_version, model, transcript, track_overrun_s, yt_duration_s)
         VALUES ($1, $2, 'sha', 'v2.2', 'claude-sonnet-5-5', '{}', 0, 600) RETURNING id`, [nativeId, videoId]);
    const data = entries.map(([start, end]) => ({ category_id: cats.prv.sponsor, start, end, confidence: 'high', source: 'ai' }));
    await dbQuery(`INSERT INTO prv_ai_video_calculateds (video_id, native_id, run_id, data, withdrawn_at, withdrawn_by, withdrawn_reason)
        VALUES ($1, $2, $3, $4, CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() - INTERVAL '1 hour' END, $5::text, $5::text)`,
    [videoId, nativeId, run.id, JSON.stringify(data), withdrawnBy]);
    await dbQuery(`INSERT INTO prv_ai_videos (native_id, status) VALUES ($1, $2)`, [nativeId, withdrawnBy ? 'withdrawn' : 'published']);
    await dbQuery('INSERT INTO prv_review_batches (batch) VALUES ($1) ON CONFLICT DO NOTHING', [batch]);
    const items = [];
    for (const [i, [start, end]] of entries.entries()) {
        const [it] = await dbQuery(
            `INSERT INTO prv_review_items (sheet, batch, item_code, position, native_id, start, "end", proposed, link, flagged_by, kind, video_id)
             VALUES ($1, $1, $2, $3, $4, $5, $6, 'sponsor', $7, $8, 'ai', $9) RETURNING id, item_code`,
            [batch, `A${firstPos + i}`, firstPos + i, nativeId, start, end, `https://example.invalid/video${nativeId}?t=${start - 2}s`,
                JSON.stringify([`judge withdraw by llm: e2e reason ${nativeId}`, 'keep: false']), videoId]);
        items.push(it);
    }
    return { videoId, items };
}

async function decideAi(item, verdict, comment = null) {
    const res = await decideReview({ item_id: item.id, verdict, comment, reviewer: REVIEWER });
    assert.equal(res.status, 201, `${item.item_code} ${verdict}: ${JSON.stringify(res.body)}`);
    return res.body;
}

const servedBounds = async (nativeId) => (await getCalculatedOn(AI_PORT, nativeId, { v: '1', duration: 600 })).body
    .map(({ category_id, start, end }) => [category_id, start, end]);

test('ai review: not_ad removes the entry, the last one withdraws the row (human path); a keep verdict sets the category or puts the entry back; sheet items untouched', async () => {
    await aiFirstServer();
    const vid = '-1_456000501';
    const batch = 'e2e-ai-apply';
    const { videoId, items: [a1, a2] } = await aiReviewSeed(vid, batch, [[30, 70], [200, 230]]);
    await postMarkup('', { video_id: vid, v: '1', user_id: 'ai-apply-human', category_id: cats.prv.sponsor,
        duration: 600, data: { intervals: [{ start: 100, end: 120 }] } });
    runCalc('prv');
    const sp = cats.prv.sponsor;
    const self = cats.prv.self_promotion;
    assert.deepEqual(await servedBounds(vid), [[sp, 30, 70], [sp, 200, 230]]);

    // A sheet item on the same stretch of the same video: the hook leaves the AI row alone.
    const sheetBatch = 'e2e-ai-apply-sheet';
    const [sheetItem] = await dbQuery(`INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, link)
        VALUES ($1, 'C1', 1, $2, 200, 230, 'sponsor', 'https://example.invalid/video-1_456000501?t=198s') RETURNING id, item_code`, [sheetBatch, vid]);
    await dbQuery('INSERT INTO prv_review_batches (batch) VALUES ($1)', [sheetBatch]);
    await takeReview(sheetBatch);
    assert.equal((await decideAi(sheetItem, 'not_ad')).ai_applied, false);
    assert.equal((await aiData(videoId)).length, 2);

    await takeReview(batch);
    const q = `reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;
    const itemHtml = async (code) => (await request('GET', `/admin/review/${batch}?item=${code}&${q}`, null)).body;
    let html = await itemHtml('A1');
    assert.ok(!html.includes(RU.text('ai_badge')) && !html.includes(`e2e reason ${vid}`), 'badge and reason blind before the verdict');

    let res = await decideAi(a1, 'not_ad');
    assert.equal(res.ai_applied, true);
    assert.deepEqual(await servedBounds(vid), [[sp, 200, 230]], 'the other entry is still served');
    html = await itemHtml('A1');
    assert.ok(html.includes(RU.text('ai_badge')), 'the AI badge after the verdict');
    assert.ok(html.includes(`${RU.text('ai_judge_reason')}</span> e2e reason ${vid}`), 'the judge’s reason after the verdict');
    assert.equal((await decideAi(a1, 'unclear')).ai_applied, false, 'the entry is already gone');

    await dbQuery(`INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt")
        VALUES ('ai-apply-voter', $1, $2, 200, 230, 1, NOW(), NOW())`, [videoId, self]);
    res = await decideAi(a2, 'self_promotion');
    assert.equal(res.ai_applied, true);
    assert.deepEqual(await servedBounds(vid), [[self, 200, 230]], 'kept with the verdict’s category');
    assert.equal((await aiData(videoId))[0].rating, 1, 'the rating of the new category’s votes');
    assert.equal((await decideAi(a2, 'self_promotion', 'same verdict, new comment')).ai_applied, false, 'idempotent');

    assert.equal((await decideAi(a2, 'not_ad')).ai_applied, true);
    let row = await aiCalculated(vid);
    assert.ok(row.withdrawn_at);
    assert.deepEqual([row.withdrawn_by, row.withdrawn_reason, row.data], ['review', `review: not_ad on ${batch} A2`, []]);
    assert.equal((await aiVideo(vid)).status, 'withdrawn');
    assert.deepEqual(await servedBounds(vid), [[sp, 100, 120]], 'the human path');

    assert.equal((await decideAi(a2, 'sponsor')).ai_applied, true);
    row = await aiCalculated(vid);
    assert.deepEqual([row.withdrawn_at, row.withdrawn_by, row.data], [null, null, [{ category_id: sp, start: 200, end: 230, source: 'ai' }]],
        'a changed mind puts the entry back and serves a row withdrawn by review again');
    assert.equal((await aiVideo(vid)).status, 'published');
    assert.deepEqual(await servedBounds(vid), [[sp, 200, 230]]);
});

test('ai review: keep verdicts restore a judge-withdrawn row once every entry is kept, never a row withdrawn by admin', async () => {
    await aiFirstServer();
    const batch = 'e2e-ai-restore';
    const judge = await aiReviewSeed('-1_456000502', batch, [[30, 70], [200, 230]], { withdrawnBy: 'judge', firstPos: 1 });
    const admin = await aiReviewSeed('-1_456000504', batch, [[30, 70]], { withdrawnBy: 'admin', firstPos: 4 });
    const early = await aiReviewSeed('-1_456000505', batch, [[30, 70], [200, 230]], { firstPos: 5 });
    await takeReview(batch);

    assert.equal((await decideAi(judge.items[0], 'sponsor')).ai_applied, false, 'one entry still waits');
    assert.ok((await aiCalculated('-1_456000502')).withdrawn_at);
    assert.equal((await decideAi(judge.items[1], 'sponsor')).ai_applied, true);
    const row = await aiCalculated('-1_456000502');
    assert.deepEqual([row.withdrawn_at, row.withdrawn_by, row.withdrawn_reason], [null, null, null]);
    assert.equal((await aiVideo('-1_456000502')).status, 'published');
    const sp = cats.prv.sponsor;
    assert.deepEqual(await servedBounds('-1_456000502'), [[sp, 30, 70], [sp, 200, 230]], 'served again');

    assert.equal((await decideAi(admin.items[0], 'sponsor')).ai_applied, false);
    const r = await aiCalculated('-1_456000504');
    assert.ok(r.withdrawn_at, 'withdrawn by admin stays withdrawn');
    assert.equal(r.withdrawn_by, 'admin');
    assert.equal((await aiVideo('-1_456000504')).status, 'withdrawn');
    assert.equal((await getCalculatedOn(AI_PORT, '-1_456000504', { v: '1', duration: 600 })).status, 204, 'no AI row served');

    // A keep verdict from before the withdraw does not count: the judge withdrew after it.
    assert.equal((await decideAi(early.items[0], 'sponsor')).ai_applied, false, 'served, same category: no change');
    await dbQuery(`UPDATE prv_ai_video_calculateds SET withdrawn_at = NOW(), withdrawn_by = 'judge', withdrawn_reason = 'e2e' WHERE video_id = $1`, [early.videoId]);
    await dbQuery(`UPDATE prv_ai_videos SET status = 'withdrawn' WHERE native_id = '-1_456000505'`);
    assert.equal((await decideAi(early.items[1], 'sponsor')).ai_applied, false, 'A5’s keep predates the withdraw');
    assert.ok((await aiCalculated('-1_456000505')).withdrawn_at);
    assert.equal((await decideAi(early.items[0], 'self_promotion')).ai_applied, true);
    assert.equal((await aiCalculated('-1_456000505')).withdrawn_at, null, 'decided again after the withdraw: served again');
    assert.equal((await aiVideo('-1_456000505')).status, 'published');
});

test('ai review: not_ad on a judge-withdrawn row removes the entry and keeps it withdrawn; a keep puts a removed entry back in start order; an ai item without an AI row changes nothing', async () => {
    await aiFirstServer();
    const batch = 'e2e-ai-apply-more';
    const vid = '-1_456000506';
    const { videoId, items: [a1, a2] } = await aiReviewSeed(vid, batch, [[30, 70], [200, 230]], { withdrawnBy: 'judge' });
    const [{ id: bareVideoId }] = await dbQuery(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt")
        VALUES ('-1_456000507', 600, NOW(), NOW()) RETURNING id`);
    const [bare] = await dbQuery(`INSERT INTO prv_review_items (sheet, batch, item_code, position, native_id, start, "end", proposed, link, kind, video_id)
        VALUES ($1, $1, 'A3', 3, '-1_456000507', 30, 70, 'sponsor', 'https://example.invalid/video-1_456000507?t=28s', 'ai', $2) RETURNING id, item_code`,
    [batch, bareVideoId]);
    await takeReview(batch);
    const sp = cats.prv.sponsor;
    const bounds = async () => (await aiData(videoId)).map(({ start, end }) => [start, end]);

    assert.equal((await decideAi(a1, 'not_ad')).ai_applied, true);
    let row = await aiCalculated(vid);
    assert.deepEqual([await bounds(), row.withdrawn_by], [[[200, 230]], 'judge'], 'entry removed, still withdrawn by the judge');
    assert.equal((await aiVideo(vid)).status, 'withdrawn');

    assert.equal((await decideAi(a2, 'sponsor')).ai_applied, true, 'every remaining entry kept: served again');
    assert.equal((await aiCalculated(vid)).withdrawn_at, null);
    assert.equal((await decideAi(a1, 'sponsor')).ai_applied, true);
    assert.deepEqual(await bounds(), [[30, 70], [200, 230]], 'put back before the later entry');
    assert.deepEqual(await servedBounds(vid), [[sp, 30, 70], [sp, 200, 230]]);

    assert.equal((await decideAi(bare, 'not_ad')).ai_applied, false, 'no AI row for the item’s video');
    assert.equal(await aiCalculated('-1_456000507'), null);
});

async function decideBounds(item, verdict, bounds, { comment = null, reviewer = REVIEWER } = {}) {
    return decideReview({ item_id: item.id, verdict, comment, reviewer, bounds });
}

const aiEntries = async videoId => (await aiData(videoId)).map(({ category_id, start, end, source, rating }) => [category_id, start, end, source, rating]);

test('ai review bounds: a keep with bounds replaces the entry (source review) and is served; votes follow the new bounds; a second correction moves it again; bad bounds are 400 in the page language', async () => {
    await aiFirstServer();
    const vid = '-1_456000511';
    const batch = 'e2e-ai-bounds';
    const sp = cats.prv.sponsor;
    const { videoId, items: [a1, a2] } = await aiReviewSeed(vid, batch, [[30, 70], [200, 230]]);
    await dbQuery(`INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt") VALUES
        ('bounds-voter-old', $1, $2, 30, 70, 1, NOW(), NOW()), ('bounds-voter-new', $1, $2, 25, 75, 1, NOW(), NOW())`, [videoId, sp]);
    await takeReview(batch);
    const verdicts = async () => (await dbQuery(`SELECT COUNT(*)::int AS n FROM prv_review_verdicts WHERE item_id = $1`, [a1.id]))[0].n;

    let res = await decideBounds(a1, 'sponsor', { start: '0:25', end: '1:15', source: 'typed' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual([res.body.ai_applied, res.body.bounds, res.body.effective_bounds],
        [true, { start: 25, end: 75, source: 'typed' }, { start: 25, end: 75, reviewer: REVIEWER, source: 'typed' }]);
    assert.deepEqual(await aiEntries(videoId), [[sp, 25, 75, 'review', 1], [sp, 200, 230, 'ai', undefined]],
        'replaced: the rating of the votes on the new bounds, the old bounds\' vote not carried over');
    assert.deepEqual((await aiData(videoId))[0].confidence, 'high', 'confidence kept');
    assert.deepEqual(await servedBounds(vid), [[sp, 25, 75], [sp, 200, 230]]);

    const vote = (userId, start, end) => requestOn(AI_PORT, 'POST', '/vote', {
        video_id: vid, user_id: userId, category_id: sp, start, end, vote: 1, duration: 600 });
    assert.equal((await vote('bounds-voter-2', 30, 70)).status, 404, 'the old bounds are no longer served');
    assert.equal((await vote('bounds-voter-2', 25, 75)).status, 204);
    assert.equal((await aiData(videoId))[0].rating, 2);

    // The same verdict, comment and bounds again: no new row; the bounds alone make a change.
    const n = await verdicts();
    res = await decideBounds(a1, 'sponsor', { start: 25, end: 75, source: 'cue' });
    assert.deepEqual([res.status, res.body.ai_applied, await verdicts()], [201, false, n]);
    res = await decideBounds(a1, 'sponsor', { start: 20, end: 80, source: 'cue' });
    assert.deepEqual([res.status, res.body.ai_applied, await verdicts()], [201, true, n + 1]);
    assert.deepEqual(await aiEntries(videoId), [[sp, 20, 80, 'review', undefined], [sp, 200, 230, 'ai', undefined]], 'moved again');

    // A later keep without bounds keeps the corrected entry; not_ad removes it, a keep puts it back where the review put it.
    res = await decideBounds(a1, 'self_promotion', null, { comment: 'own channel' });
    assert.deepEqual([res.body.ai_applied, res.body.bounds, res.body.effective_bounds.start], [true, null, 20]);
    assert.deepEqual((await aiEntries(videoId))[0], [cats.prv.self_promotion, 20, 80, 'review', undefined]);
    assert.equal((await decideBounds(a1, 'not_ad', null)).body.ai_applied, true);
    assert.deepEqual(await servedBounds(vid), [[sp, 200, 230]]);
    assert.equal((await decideBounds(a1, 'sponsor', null)).body.ai_applied, true);
    assert.deepEqual((await aiEntries(videoId))[0], [sp, 20, 80, 'review', undefined]);

    // Bounds equal to the item's own: stored, the entry stays the detector's.
    res = await decideBounds(a2, 'sponsor', { start: 200, end: 230, source: 'typed' });
    assert.deepEqual([res.status, res.body.ai_applied, res.body.bounds], [201, false, { start: 200, end: 230, source: 'typed' }]);
    assert.deepEqual((await aiEntries(videoId))[1], [sp, 200, 230, 'ai', undefined]);

    const n2 = await verdicts();
    for (const [verdict, bounds, key] of [
        ['not_ad', { start: 20, end: 80, source: 'typed' }, 'error_bounds_not_keep'],
        ['unclear', { start: 20, end: 80, source: 'typed' }, 'error_bounds_not_keep'],
        ['sponsor', { start: 20, end: 80 }, 'error_bounds_source'],
        ['sponsor', { start: 20, end: 80, source: 'import' }, 'error_bounds_source'],
        ['sponsor', { start: '1:5x', end: 80, source: 'typed' }, 'error_bounds_format'],
        ['sponsor', { start: 20.5, end: 80, source: 'typed' }, 'error_bounds_format'],
        ['sponsor', { start: 20, end: '24:00:01', source: 'typed' }, 'error_bounds_range'],
        ['sponsor', { start: 80, end: 20, source: 'typed' }, 'error_bounds_order'],
        ['sponsor', { start: 20, end: 24, source: 'typed' }, 'error_bounds_short'],
        ['sponsor', [20, 80], 'error_bounds_format'],
    ]) {
        res = await decideBounds(a1, verdict, bounds);
        assert.deepEqual([res.status, res.body], [400, RU.text(key)], `${verdict} ${JSON.stringify(bounds)}`);
    }
    res = await decideBounds(a2, 'sponsor', { start: 70, end: 210, source: 'typed' });
    assert.deepEqual([res.status, res.body], [400, RU.text('error_bounds_overlap')], 'overlaps the other entry');
    res = await request('POST', `/admin/review/decide?verifyBearerToken=${MOD_AUTH}&lang=en`,
        { item_id: a2.id, verdict: 'sponsor', reviewer: REVIEWER, bounds: { start: 70, end: 210, source: 'typed' } });
    assert.equal(res.body, translator('en').text('error_bounds_overlap'), 'in the requested language');
    assert.equal(await verdicts(), n2, 'nothing written');
    assert.deepEqual(await servedBounds(vid), [[sp, 20, 80], [sp, 200, 230]]);

    // The item JSON: verdict bounds in the history, the effective and own bounds.
    const json = (await getReview(batch, { item: 'A1', format: 'json' })).body.item;
    assert.deepEqual([json.effective_bounds, json.own_bounds], [{ start: 20, end: 80, reviewer: REVIEWER, source: 'cue' }, null]);
    assert.deepEqual(json.history.map(h => h.bounds && [h.bounds.start, h.bounds.end, h.bounds.source]),
        [null, null, null, [20, 80, 'cue'], [25, 75, 'typed']]);

    // --recompute-ratings rewrites the moved entry from the votes on its bounds.
    await dbQuery(`INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt")
        VALUES ('bounds-voter-3', $1, $2, 20, 80, -1, NOW(), NOW())`, [videoId, sp]);
    runRecomputeRatings('prv');
    assert.deepEqual((await aiEntries(videoId))[0], [sp, 20, 80, 'review', -1]);

    // /admin/video marks the review-set entry.
    const admin = await request('GET', `/admin/video/${videoId}?verifyBearerToken=${MOD_AUTH}`, null);
    assert.equal((admin.body.match(/class="badge review-badge"/g) || []).length, 1, 'one entry has review bounds');
});

test('ai review bounds: a sheet item stores them and applies nothing; a judge-withdrawn row with a moved entry is restored through its new bounds; an admin-withdrawn one stays withdrawn', async () => {
    await aiFirstServer();
    const sp = cats.prv.sponsor;
    const sheetBatch = 'e2e-bounds-sheet';
    const [sheetItem] = await dbQuery(`INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, link)
        VALUES ($1, 'C1', 1, '-1_456000512', 100.4, 130.2, 'sponsor', 'https://example.invalid/video-1_456000512?t=98s') RETURNING id, item_code`, [sheetBatch]);
    await dbQuery('INSERT INTO prv_review_batches (batch) VALUES ($1)', [sheetBatch]);
    await takeReview(sheetBatch);
    let res = await decideBounds(sheetItem, 'sponsor', { start: '1:35', end: '2:20', source: 'typed' });
    assert.deepEqual([res.status, res.body.ai_applied, res.body.effective_bounds],
        [201, false, { start: 95, end: 140, reviewer: REVIEWER, source: 'typed' }]);
    const [stored] = await dbQuery(`SELECT start, "end", bounds_source, source FROM prv_review_verdicts WHERE item_id = $1`, [sheetItem.id]);
    assert.deepEqual(stored, { start: 95, end: 140, bounds_source: 'typed', source: 'page' });

    const batch = 'e2e-bounds-restore';
    const judge = await aiReviewSeed('-1_456000513', batch, [[30, 70], [200, 230]], { withdrawnBy: 'judge' });
    const admin = await aiReviewSeed('-1_456000514', batch, [[30, 70]], { withdrawnBy: 'admin', firstPos: 3 });
    await takeReview(batch);
    res = await decideBounds(judge.items[0], 'sponsor', { start: 25, end: 75, source: 'cue' });
    assert.equal(res.body.ai_applied, true, 'the entry moved');
    assert.ok((await aiCalculated('-1_456000513')).withdrawn_at, 'one entry still waits');
    assert.equal((await decideBounds(judge.items[1], 'sponsor', null)).body.ai_applied, true);
    assert.equal((await aiCalculated('-1_456000513')).withdrawn_at, null, 'every entry kept at its effective bounds: served again');
    assert.deepEqual(await servedBounds('-1_456000513'), [[sp, 25, 75], [sp, 200, 230]]);

    assert.equal((await decideBounds(admin.items[0], 'sponsor', { start: 25, end: 75, source: 'typed' })).body.ai_applied, true);
    const row = await aiCalculated('-1_456000514');
    assert.deepEqual([row.withdrawn_by, row.data.map(e => [e.start, e.end, e.source])], ['admin', [[25, 75, 'review']]],
        'bounds applied to the record, the operator\'s withdraw stays');
});

test('ai review bounds: the item page carries the transcript window (words when stored) and the bounds inputs; a sheet item has no transcript', async () => {
    const vid = '-1_456000515';
    const batch = 'e2e-bounds-transcript';
    const { videoId, items: [a1] } = await aiReviewSeed(vid, batch, [[30, 70]]);
    const transcript = { meta: {}, cues: [
        { start: 28, end: 33, text: 'этот выпуск спонсирует', words: [{ t: 28, text: 'этот' }, { t: 29.5, text: 'выпуск' }, { t: 31, text: 'спонсирует' }] },
        { start: 33, end: 40, text: 'переходите по ссылке' },
        { start: 300, end: 305, text: 'далее по теме' },
    ] };
    await dbQuery(`UPDATE prv_ai_runs SET transcript = $2 WHERE id = (SELECT run_id FROM prv_ai_video_calculateds WHERE video_id = $1)`,
        [videoId, JSON.stringify(transcript)]);
    await takeReview(batch);

    let body = (await getReview(batch, { item: 'A1', format: 'json' })).body;
    assert.deepEqual([body.context, body.transcript], [60, { from: 0, to: 130, has_words: true, cues: transcript.cues.slice(0, 2) }]);
    body = (await getReview(batch, { item: 'A1', format: 'json', context: '600' })).body;
    assert.deepEqual([body.transcript.to, body.transcript.cues.length], [670, 3]);
    for (const context of ['601', '-1', '1.5', 'x']) {
        const res = await getReview(batch, { item: 'A1', format: 'json', context });
        assert.equal(res.status, 400, `context=${context}`);
    }
    // Corrected bounds widen the window around them.
    assert.equal((await decideBounds(a1, 'sponsor', { start: 30, end: 300, source: 'typed' })).status, 201);
    body = (await getReview(batch, { item: 'A1', format: 'json', context: '0' })).body;
    assert.deepEqual([body.transcript.from, body.transcript.to, body.transcript.cues.length], [30, 300, 3]);

    let html = (await getReview(batch, { item: 'A1' })).body;
    assert.ok(html.includes('id="transcript"') && html.includes('data-t="29.5" data-e="31"'), 'words with their times');
    assert.ok(html.includes('class="leaf hl-item hl-eff" data-t="33" data-e="40"'), 'a line without words, flagged and corrected');
    assert.ok(!html.includes(RU('transcript_no_words')), 'words stored: no snap notice');
    assert.ok(html.includes(RU('item_corrected', { start: '0:30', end: '5:00', name: REVIEWER })));
    assert.match(html, /id="bound-start"[^>]*value="0:30"/, 'pre-filled from the reviewer\'s own bounds');
    assert.match(html, /context=120/, 'the +60 s control');

    await dbQuery(`UPDATE prv_ai_runs SET transcript = $2 WHERE id = (SELECT run_id FROM prv_ai_video_calculateds WHERE video_id = $1)`,
        [videoId, JSON.stringify(AI_TRANSCRIPT)]);
    html = (await getReview(batch, { item: 'A1', context: '0' })).body;
    assert.ok(html.includes(RU('transcript_no_words')), 'no word times: the selection snaps to lines');

    const sheet = 'e2e-bounds-transcript-sheet';
    await dbQuery(`INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, cues, link)
        VALUES ($1, 'C1', 1, $2, 30, 70, 'sponsor', 'цитата', 'https://example.invalid/video-1_456000515?t=28s')`, [sheet, vid]);
    await dbQuery('INSERT INTO prv_review_batches (batch) VALUES ($1)', [sheet]);
    body = (await getReview(sheet, { item: 'C1', format: 'json' })).body;
    assert.equal(body.transcript, null);
    html = (await getReview(sheet, { item: 'C1' })).body;
    assert.ok(!html.includes('id="transcript"') && html.includes('цитата') && html.includes('id="bound-start"'), 'typed bounds only');
});

test('ai judge: a keep verdict that moved the entry is its baseline: every entry kept → ok by rules, the old bounds\' signals stay behind', async () => {
    const vid = '-1_456000412';
    const sp = cats.prv.sponsor;
    const { videoId } = await aiPublished(vid, 25);
    const judge = () => {
        const r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on', AI_JUDGE_MIN_INTERVAL: '0' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        return r.stdout + r.stderr;
    };
    await postUndo(vid, 'moved-u1', 30, 70);
    judge();
    const [item] = await aiItems(videoId);
    assert.ok(item, 'the undo sent the entry to review');
    const before = (await aiVideo(vid)).judged_at;

    await takeReview(item.batch);
    const res = await decideBounds(item, 'sponsor', { start: 25, end: 75, source: 'cue' });
    assert.deepEqual([res.status, res.body.ai_applied], [201, true]);
    assert.deepEqual((await aiData(videoId)).map(e => [e.category_id, e.start, e.end, e.source]), [[sp, 25, 75, 'review']]);
    await lockReview('release', item.batch, { reviewer: REVIEWER });

    const out = judge();
    const j = (await judgements(videoId)).at(-1);
    assert.deepEqual([j.decision, j.by, j.reason], ['ok', 'rules', 'every entry kept on review since the last judgement']);
    assert.match(out, new RegExp(`ai judge: ${videoId} ok rules: every entry kept on review since the last judgement`));
    assert.ok((await aiVideo(vid)).judged_at > before, 'judged_at moves past the verdict');
    assert.equal((await aiItems(videoId)).length, 1, 'no new item');
});

// ── Acceptance (Task 10): the whole AI path in one scenario, and every flag at its default ──

const entryTuples = body => body.map(({ category_id, start, end, rating }) => [category_id, start, end, rating]);

test('ai full path: views request → detect → served → vote → undo → judge withdraw → review item → sponsor → served again → admin withdraw → human path', async () => {
    await aiFirstServer();
    const vid = '-1_456000601';
    const sp = cats.prv.sponsor;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'full-path-human', category_id: sp,
        duration: 600, data: { intervals: [{ start: 100, end: 120 }] } });
    runCalc('prv');
    const human = [[sp, 100, 120, undefined]];
    const served = async () => entryTuples((await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600 })).body);

    let res = await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600, views_text: '50 тыс просмотров' });
    assert.deepEqual(entryTuples(res.body), human, 'not detected yet: the human path');
    assert.deepEqual([(await waitAiVideo(vid, 1)).status, (await aiVideo(vid)).views_max], ['seen', 50000]);

    // A huge fallback keeps rows that earlier tests requested without views out of this tick.
    let r = runAi(['detect'], { AI_FALLBACK_REQUESTS: '1000000' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /ai detect: -1_456000601 published: 1 entries of 3 segments/);
    const videoId = await prvVideoId(vid);
    assert.equal((await aiCalculated(vid)).video_id, videoId, 'the human markup’s videos row');
    assert.deepEqual(await served(), [[sp, 30, 70, undefined]]);

    res = await requestOn(AI_PORT, 'POST', '/vote', { video_id: vid, user_id: 'full-path-voter', category_id: sp,
        start: 30, end: 70, vote: 1, duration: 600 });
    assert.equal(res.status, 204);
    assert.deepEqual(await served(), [[sp, 30, 70, 1]]);
    await postUndo(vid, 'full-path-undo', 30, 70);

    await dbQuery(`UPDATE prv_ai_video_calculateds SET published_at = NOW() - INTERVAL '25 hours' WHERE video_id = $1`, [videoId]);
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const [j] = await judgements(videoId);
    assert.deepEqual([j.decision, j.by, j.reason, j.signals.undo, j.signals.votes_up], ['withdraw', 'llm', fixtureReason(vid), 1, 1]);
    assert.equal((await aiCalculated(vid)).withdrawn_by, 'judge');
    assert.equal((await aiVideo(vid)).status, 'withdrawn');
    assert.deepEqual(await served(), human, 'withdrawn by the judge: the human path');

    const [it] = await aiItems(videoId);
    assert.deepEqual([it.kind, it.start, it.end, it.proposed, it.flagged_by.at(-1)], ['ai', 30, 70, 'sponsor', 'keep: false']);
    await takeReview(it.batch);
    assert.equal((await decideAi(it, 'sponsor')).ai_applied, true);
    assert.equal((await lockReview('release', it.batch, { reviewer: REVIEWER })).status, 200);
    assert.deepEqual([(await aiCalculated(vid)).withdrawn_at, (await aiVideo(vid)).status], [null, 'published']);
    assert.deepEqual(await served(), [[sp, 30, 70, 1]], 'served again, the vote kept');

    res = await requestOn(AI_PORT, 'GET', `/admin/video/${videoId}/ai/withdraw?verifyBearerToken=${VOTE_AUTH}`);
    assert.equal(res.status, 200);
    assert.equal((await aiCalculated(vid)).withdrawn_by, 'admin');
    assert.deepEqual(await served(), human, 'the operator’s switch: the human path');
});

test('ai judge: a human keep is a new baseline: only later signals count, a re-cut never keeps them from the LLM and its withdraw', async () => {
    await aiFirstServer();
    const vid = '-1_456000406';
    const { videoId } = await aiPublished(vid);
    await postMarkup('', { video_id: vid, v: '1', user_id: 'keep-recut', category_id: cats.prv.sponsor,
        duration: 900, data: { intervals: [{ start: 10, end: 40 }] } });
    await getCalculated('', vid, { v: '1', duration: 900 });
    await waitAiVideo(vid, 2);

    let r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    let js = await judgements(videoId);
    assert.deepEqual(js.map(j => [j.decision, j.by, j.reason]), [['review', 'rules', 'duration: 1 videos rows of another cut requested after publish']]);
    const [it] = await aiItems(videoId);
    await postUndo(vid, 'keep-u1', 30, 70); // before the verdict: the reviewer has seen it
    await takeReview(it.batch);
    await decideAi(it, 'sponsor');
    assert.equal((await lockReview('release', it.batch, { reviewer: REVIEWER })).status, 200);

    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    js = await judgements(videoId);
    assert.deepEqual(js.map(j => [j.decision, j.by, j.reason]).at(-1), ['ok', 'rules', 'every entry kept on review since the last judgement']);
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
    assert.equal((await judgements(videoId)).length, js.length, 'recorded once: judged_at moved past the verdict');

    await postUndo(vid, 'keep-u2', 30, 70);
    r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on', AI_JUDGE_MIN_INTERVAL: '0' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = (await judgements(videoId)).at(-1);
    assert.deepEqual([j.decision, j.by, j.reason, j.signals.undo, j.signals.duration_recut], ['withdraw', 'llm', fixtureReason(vid), 2, 1],
        'the undo after the keep reaches the LLM despite the re-cut');
    assert.equal((await aiCalculated(vid)).withdrawn_by, 'judge');
    const items = await aiItems(videoId);
    assert.equal(items.length, 2, 'a new item: the first one has its verdict');
    assert.deepEqual(items[1].flagged_by, [`judge withdraw by llm: ${j.reason}`, 'signals: undo=2 duration_recut=1', 'keep: false']);
});

// Each case slipped through the count comparison the judge used before (a total that shrank, one user's
// dislike on a second entry, a repeated vote read as new after a keep).
test('ai judge: new evidence is what was created after the baseline: dislikes after the total fell, a user’s dislike on another entry, never a repeated vote', async () => {
    await aiFirstServer();
    const sp = cats.prv.sponsor;
    const vote = (vid, userId, start, end, value) => requestOn(AI_PORT, 'POST', '/vote', {
        video_id: vid, user_id: userId, category_id: sp, start, end, vote: value, duration: 600 });
    const judge = () => {
        const r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on', AI_JUDGE_MIN_INTERVAL: '0' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
    };
    const votesDown = async videoId => (await judgements(videoId)).map(j => [j.decision, j.by, j.signals.votes_down, j.signals.new.votes_down]);

    const shrank = await aiPublished('-1_456000407');
    for (const u of ['shrink-1', 'shrink-2', 'shrink-3']) assert.equal((await vote('-1_456000407', u, 30, 70, -1)).status, 204);
    const two = await aiPublished('-1_456000408', 25, [
        { category_id: sp, start: 30, end: 70, confidence: 'high', source: 'ai' },
        { category_id: sp, start: 200, end: 230, confidence: 'high', source: 'ai' }]);
    assert.equal((await vote('-1_456000408', 'two-u', 30, 70, -1)).status, 204);
    const kept = await aiPublished('-1_456000409');
    assert.equal((await vote('-1_456000409', 'kept-u', 30, 70, -1)).status, 204);
    judge();
    assert.deepEqual(await votesDown(shrank.videoId), [['ok', 'llm', 3, 3]]);
    assert.deepEqual(await votesDown(two.videoId), [['ok', 'llm', 1, 1]]);
    assert.deepEqual(await votesDown(kept.videoId), [['review', 'llm', 1, 1]]);

    for (const u of ['shrink-1', 'shrink-2', 'shrink-3']) assert.equal((await vote('-1_456000407', u, 30, 70, 1)).status, 204);
    for (const u of ['shrink-4', 'shrink-5']) assert.equal((await vote('-1_456000407', u, 30, 70, -1)).status, 204);
    assert.equal((await vote('-1_456000408', 'two-u', 200, 230, -1)).status, 204);
    const [it] = await aiItems(kept.videoId);
    await takeReview(it.batch);
    await decideAi(it, 'sponsor');
    assert.equal((await lockReview('release', it.batch, { reviewer: REVIEWER })).status, 200);
    judge();
    assert.deepEqual(await votesDown(shrank.videoId), [['ok', 'llm', 3, 3], ['ok', 'llm', 2, 2]], 'two new dislikes, fewer than before');
    assert.deepEqual(await votesDown(two.videoId), [['ok', 'llm', 1, 1], ['ok', 'llm', 2, 1]], 'the same user on the other entry');
    assert.deepEqual((await votesDown(kept.videoId)).at(-1), ['ok', 'rules', 1, 0]);

    const voteRows = () => dbQuery(`SELECT id, "createdAt" FROM votes WHERE user_id = 'kept-u'`);
    const rows = await voteRows();
    assert.equal((await vote('-1_456000409', 'kept-u', 30, 70, -1)).status, 204);
    assert.deepEqual(await voteRows(), rows, 'a repeated vote keeps its row and time');
    assert.equal((await aiData(kept.videoId))[0].rating, -1);
    judge();
    assert.equal((await judgements(kept.videoId)).length, 2, 'the repeated dislike is no new evidence');
    assert.equal((await judgements(shrank.videoId)).length, 2);
    assert.equal((await judgements(two.videoId)).length, 2);

    assert.equal((await vote('-1_456000409', 'kept-v', 30, 70, -1)).status, 204);
    judge();
    assert.deepEqual((await votesDown(kept.videoId)).at(-1), ['review', 'llm', 2, 1], 'another user’s dislike after the keep is');
});

// Each entry's evidence counts after its own keep: an undo on A after A's keep but before B's is new.
test('ai judge: the keep baseline is per entry', async () => {
    const vid = '-1_456000410';
    const sp = cats.prv.sponsor;
    const { videoId } = await aiPublished(vid, 25, [
        { category_id: sp, start: 30, end: 70, confidence: 'high', source: 'ai' },
        { category_id: sp, start: 200, end: 230, confidence: 'high', source: 'ai' }]);
    const judge = () => {
        const r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on', AI_JUDGE_MIN_INTERVAL: '0' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
    };
    await postUndo(vid, 'entry-u1', 30, 70);
    await postUndo(vid, 'entry-u1', 200, 230);
    judge();
    const items = await aiItems(videoId);
    assert.deepEqual(items.map(i => [i.start, i.end]), [[30, 70], [200, 230]]);

    await takeReview(items[0].batch);
    await decideAi(items[0], 'sponsor');
    await postUndo(vid, 'entry-u2', 30, 70);
    await decideAi(items[1], 'sponsor');
    await lockReview('release', items[0].batch, { reviewer: REVIEWER });
    judge();
    const j = (await judgements(videoId)).at(-1);
    assert.deepEqual([j.decision, j.by, j.signals.undo, j.signals.new.undo], ['review', 'llm', 3, 1],
        'the undo after A\'s keep is new although B was kept later');
});

// PUT /markups edits an interval in place: an edit into a conflict after the baseline is new evidence.
test('ai judge: a human interval edited into a conflict is new evidence (bounds or category)', async () => {
    const vid = '-1_456000411';
    const { videoId } = await aiPublished(vid);
    const sp = cats.prv.sponsor;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'edit-a', category_id: sp, duration: 600, data: { intervals: [{ start: 32, end: 68 }] } });
    await postMarkup('', { video_id: vid, v: '1', user_id: 'edit-b', category_id: cats.prv.intro, duration: 600, data: { intervals: [{ start: 400, end: 430 }] } });
    const judge = () => {
        const r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on', AI_JUDGE_MIN_INTERVAL: '0' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
    };
    const conflicts = async () => (await judgements(videoId)).map(j => [j.by, j.signals.conflicting_markups, j.signals.new.conflicting_markups]);
    judge();
    assert.deepEqual(await conflicts(), [['rules', 0, 0]], 'one agreeing sponsor, one intro');

    assert.equal((await putMarkup('', { video_id: vid, user_id: 'edit-a', category_id: sp, start: 32, end: 68, new_start: 100, new_end: 130 })).status, 200);
    judge();
    assert.deepEqual((await conflicts()).at(-1), ['llm', 1, 1], 'bounds moved off the AI entry');

    assert.equal((await putMarkup('', { video_id: vid, user_id: 'edit-b', category_id: cats.prv.intro, start: 400, end: 430, new_category_id: sp })).status, 200);
    judge();
    assert.deepEqual((await conflicts()).at(-1), ['llm', 2, 1], 'intro turned sponsor');
    judge();
    assert.equal((await judgements(videoId)).length, 3, 'nothing newer: not judged again');

    await postMarkup('', { video_id: vid, v: '1', user_id: 'edit-c', category_id: cats.prv.intro, duration: 600,
        data: { intervals: [{ start: 32, end: 68 }, { start: 500, end: 530 }] } });
    assert.equal((await putMarkup('', { video_id: vid, user_id: 'edit-c', category_id: cats.prv.intro, start: 32, end: 68, new_category_id: sp })).status, 200);
    judge();
    assert.deepEqual((await conflicts()).at(-1), ['llm', 3, 1], 'the category change turned the other interval of the markup sponsor too');
});

test('ai judge: review items go to the day’s newest part that nobody holds or has started, within 30 items', async () => {
    const sheet = `ai-judge-${new Date().toISOString().slice(0, 10)}`;
    const parts = async () => (await dbQuery(`SELECT DISTINCT batch FROM prv_review_items WHERE COALESCE(sheet, batch) = $1`, [sheet])).map(r => r.batch);
    const partName = k => (k === 1 ? sheet : `${sheet}-p${k}`); // the k-th part of the sheet
    const n = (await parts()).length;
    const held = (await dbQuery(`UPDATE prv_review_batches SET locked_by = 'gkshi', locked_at = NOW()
        WHERE batch = ANY($1) AND locked_by IS NULL RETURNING batch`, [await parts()])).map(r => r.batch);
    const judgeOn = async (...nativeIds) => {
        const videos = [];
        for (const id of nativeIds) {
            videos.push(await aiPublished(id));
            await postUndo(id, 'parts-undo', 30, 70);
        }
        const r = runAi(['judge'], { AI_JUDGE_ENABLED: 'on' });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        return Promise.all(videos.map(async v => (await aiItems(v.videoId))[0]));
    };
    try {
        const [x, y] = await judgeOn('-1_456000701', '-1_456000702');
        assert.deepEqual([x.batch, y.batch], [partName(n + 1), partName(n + 1)], 'every earlier part is held: a new one, shared while untouched');
        assert.equal(Number(y.item_code.slice(1)), Number(x.item_code.slice(1)) + 1);

        await dbQuery(`INSERT INTO prv_review_verdicts (item_id, verdict, reviewer, source) VALUES ($1, 'sponsor', 'bayanovea', 'page')`, [x.id]);
        const [z] = await judgeOn('-1_456000703');
        assert.equal(z.batch, partName(n + 2), 'a part with a verdict never grows');

        for (let i = 1; i <= 29; i++) {
            await dbQuery(`INSERT INTO prv_review_items (sheet, batch, item_code, position, native_id, start, "end", proposed, link)
                VALUES ($1, $2, $3, $4, '-1_456000703', $5, $6, 'sponsor', 'https://example.invalid/video-1_456000703')`,
            [sheet, z.batch, `F${i}`, 1000 + i, 10 * i, 10 * i + 5]);
        }
        const [w] = await judgeOn('-1_456000704');
        assert.equal(w.batch, partName(n + 3), 'a full part (30 items) never grows');
    } finally {
        await dbQuery(`DELETE FROM prv_review_items WHERE COALESCE(sheet, batch) = $1 AND item_code LIKE 'F%'`, [sheet]);
        await dbQuery(`UPDATE prv_review_batches SET locked_by = NULL, locked_at = NULL WHERE batch = ANY($1)`, [held]);
    }
});

// Every AI_* variable (and the yt-dlp / key ones) dropped, as on a deploy that sets none of them.
const NO_AI_ENV = Object.fromEntries([...Object.keys(process.env).filter(k => k.startsWith('AI_')),
    'AI_DETECT_ENABLED', 'YTDLP_BIN', 'ANTHROPIC_API_KEY'].map(k => [k, undefined]));

// What the detector, the judge and the review hook write; prv_ai_videos without the read path's upsert columns.
async function aiSnapshot() {
    const snap = {};
    for (const t of ['prv_ai_runs', 'prv_ai_video_calculateds', 'prv_ai_judgements', 'prv_ai_timelines',
        'prv_review_items', 'prv_review_verdicts', 'prv_review_batches']) snap[t] = await dbQuery(`SELECT * FROM ${t} ORDER BY 1`);
    snap.prv_ai_videos = await dbQuery(`SELECT native_id, status, attempts, next_attempt_at, batch_id, last_error,
        judged_at, judge_counters, first_seen_at FROM prv_ai_videos ORDER BY native_id`);
    snap.heartbeats = await dbQuery(`SELECT * FROM calculator_heartbeats WHERE provider LIKE 'ai_%'`);
    return snap;
}

test('ai defaults: with no AI_* env the app serves and votes as before the plan, ai detect / judge do nothing', async () => {
    await aiFirstServer();
    const port = 3097;
    const plain = startServer(port, { ...NO_AI_ENV, AUTH_TOKEN: undefined }, 'no-ai');
    try {
        await waitForListen(port);
        const vid = '-1_456000602';
        const { videoId, ai } = await aiFirstVideo(vid);
        // Work for both commands if they ran: a queued video above AI_MIN_VIEWS, and this row due for the judge.
        await dbQuery(`INSERT INTO prv_ai_videos (native_id, views_max, requests) VALUES ('-1_456000603', 50000, 1)`);
        await dbQuery(`UPDATE prv_ai_video_calculateds SET published_at = NOW() - INTERVAL '25 hours' WHERE video_id = $1`, [videoId]);
        await postUndo(vid, 'defaults-undo', 30, 70);
        await dbQuery(`INSERT INTO calculator_heartbeats (provider, last_run_at, last_success_at, failed_videos)
            VALUES ('ai_detect', NOW(), NOW(), 0), ('ai_judge', NOW(), NOW(), 0)
            ON CONFLICT (provider) DO UPDATE SET last_run_at = NOW(), last_success_at = NOW()`);
        const before = await aiSnapshot();
        const { requests } = await aiVideo(vid);

        const stored = (await dbQuery(`SELECT data FROM video_calculateds WHERE video_id = $1`, [videoId]))[0].data;
        for (const query of [{ v: '1', duration: 600, views_text: '50 тыс просмотров' }, { v: '1', duration: 600 }, { duration: 600 }]) {
            const res = await getCalculatedOn(port, vid, query);
            assert.deepEqual([res.status, res.body], [200, stored], `the stored human data for ${JSON.stringify(query)}`);
            assert.deepEqual((await getCalculatedOn(E2E_PORT, vid, query)).body, stored, 'the same as the default test app');
        }
        assert.deepEqual((await getCalculatedOn(AI_PORT, vid, { v: '1', duration: 600 })).body, ai, 'the AI row is live: AI_FIRST=on serves it');

        const vote = (start, end) => requestOn(port, 'POST', '/vote', { video_id: vid, user_id: 'defaults-voter',
            category_id: cats.prv.sponsor, start, end, vote: 1, duration: 600 });
        assert.equal((await vote(30, 70)).status, 404, 'the AI entry is not served, so not votable');
        assert.equal((await vote(100, 120)).status, 204);
        assert.equal(await getJsonRating('', vid, cats.prv.sponsor, 100, 120), 1);
        for (const q of ['', '?verifyBearerToken=']) {
            const res = await requestOn(port, 'GET', `/admin/video/${videoId}/ai/withdraw${q}`);
            assert.equal(res.status, 401, `AUTH_TOKEN unset refuses the withdraw link (${q || 'no token'})`);
        }

        for (const cmd of ['detect', 'judge']) {
            const r = runAi([cmd], NO_AI_ENV);
            assert.deepEqual([r.status, r.stdout + r.stderr], [0, ''], `ai ${cmd}: exit 0, silent`);
        }

        const row = await waitAiVideo(vid, requests + 5); // every GET with v above (the legacy ones write nothing)
        assert.deepEqual([row.requests, row.views_max], [requests + 5, 50000], 'the read path’s upsert is the only AI write');
        const after = await aiSnapshot();
        assert.deepEqual(after.heartbeats, [], 'switched-off commands clear their heartbeats');
        delete before.heartbeats;
        delete after.heartbeats;
        assert.deepEqual(after, before);
    } finally {
        plain.kill();
    }
});

// The gauges mirror the AI tables, whatever earlier tests left there; rows of its own (a published
// video, an LLM judgement from 2 days ago and one from now, a decided and an open item) keep it from being vacuous.
test('ai metrics: /metrics exposes the AI gauges from the tables', async () => {
    const { videoId, items: [decided] } = await aiReviewSeed('-1_456000801', 'e2e-ai-metrics', [[30, 70], [200, 230]]);
    await dbQuery(`INSERT INTO prv_review_verdicts (item_id, verdict, reviewer, source) VALUES ($1, 'sponsor', 'bayanovea', 'page')`, [decided.id]);
    await dbQuery(`INSERT INTO prv_ai_judgements (video_id, decision, "by", signals, model, cost_usd, created_at)
        VALUES ($1, 'review', 'llm', '{}', 'm', 0.5, NOW() - INTERVAL '2 days'), ($1, 'review', 'llm', '{}', 'm', 0.25, NOW())`, [videoId]);
    const text = await fetchMetrics();
    const statuses = await dbQuery(`SELECT status, COUNT(*)::int AS n FROM prv_ai_videos GROUP BY status`);
    assert.ok(statuses.some(r => r.status === 'published' && r.n > 0));
    for (const { status, n } of statuses) assert.equal(parseCounter(text, 'ai_videos', { status }), n, `ai_videos{status="${status}"}`);

    const [{ detect, judge }] = await dbQuery(`SELECT
        (SELECT COALESCE(SUM(cost_usd), 0) FROM prv_ai_runs) AS detect,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM prv_ai_judgements) AS judge`);
    assert.match(text, new RegExp(`^ai_cost_usd\\{kind="detect"\\} ${Number(detect)}$`, 'm'));
    assert.match(text, new RegExp(`^ai_cost_usd\\{kind="judge"\\} ${Number(judge)}$`, 'm'));
    const [day] = await dbQuery(`SELECT
        (SELECT COALESCE(SUM(cost_usd), 0) FROM prv_ai_runs WHERE created_at > NOW() - INTERVAL '24 hours') AS detect,
        (SELECT COALESCE(SUM(cost_usd), 0) FROM prv_ai_judgements WHERE created_at > NOW() - INTERVAL '24 hours') AS judge`);
    assert.ok(Number(day.judge) < Number(judge), 'the 2-day-old judgement is outside the 24 h');
    assert.match(text, new RegExp(`^ai_cost_usd_24h\\{kind="detect"\\} ${Number(day.detect)}$`, 'm'));
    assert.match(text, new RegExp(`^ai_cost_usd_24h\\{kind="judge"\\} ${Number(day.judge)}$`, 'm'));

    const judged = await dbQuery(`SELECT decision, "by", COUNT(*)::int AS n FROM prv_ai_judgements GROUP BY decision, "by"`);
    assert.ok(judged.some(r => r.decision === 'review' && r.by === 'llm'));
    for (const { decision, by, n } of judged) {
        assert.equal(parseCounter(text, 'ai_judgements', { decision, by }), n, `ai_judgements{${decision},${by}}`);
    }

    const [{ open }] = await dbQuery(`SELECT COUNT(*)::int AS open FROM prv_review_items i
        WHERE kind = 'ai' AND NOT EXISTS (SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id)`);
    const [{ ai }] = await dbQuery(`SELECT COUNT(*)::int AS ai FROM prv_review_items WHERE kind = 'ai'`);
    assert.ok(open > 0 && open < ai, `some ai items decided, some open (${open} of ${ai})`);
    assert.match(text, new RegExp(`^ai_review_open ${open}$`, 'm'));
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

// The same vote twice: one row (its time kept), the author moved once, a drifted rating repaired;
// the delete then takes the author back to the start.
test('prv vote: a repeated identical vote is a no-op that still repairs the segment rating', async () => {
    const vid = '__e2e__prv_vote_repeat';
    const cat = cats.prv.intro;
    const author = 'prv-repeat-author';
    await postMarkup('', { video_id: vid, v: '1', user_id: author, category_id: cat, data: { intervals: [{ start: 1, end: 11 }] } });
    runCalc('prv');

    const authorBefore = await userRating('', author);
    const voteBody = { video_id: vid, user_id: 'prv-repeat-voter', category_id: cat, start: 1, end: 11, vote: 1 };
    await postVote('', voteBody);
    const rowsOf = () => dbQuery(
        `SELECT vt.id, vt."createdAt" FROM votes vt JOIN videos v ON v.id = vt.video_id WHERE v.native_id = $1`, [vid]);
    const rows = await rowsOf();
    await dbQuery(
        'UPDATE prv_calculated_segments s SET rating = 5 FROM videos v WHERE v.id = s.video_id AND v.native_id = $1', [vid]);

    await postVote('', voteBody);
    assert.deepEqual(await rowsOf(), rows, 'one vote row, its time kept');
    assert.equal(await userRating('', author), authorBefore + 1, 'the author moved once');
    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 1, 'the drifted rating repaired');

    const res = await request('GET', `/votes/${rows[0].id}/delete?verifyBearerToken=${VOTE_AUTH}`, null);
    assert.equal(res.status, 201);
    assert.equal(await userRating('', author), authorBefore, 'the delete takes the author back');
    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, 0);
});

// Pre-2026-10-17 rows: [older -1, latest +1]. A -1 now is a change from the latest, not a repeat of
// the older row; it replaces both.
test('prv vote: a vote matching an older legacy row of the user is a change from the latest one', async () => {
    const vid = '__e2e__prv_vote_legacy_dup';
    const cat = cats.prv.intro;
    const author = 'prv-legacy-author';
    await postMarkup('', { video_id: vid, v: '1', user_id: author, category_id: cat, data: { intervals: [{ start: 1, end: 11 }] } });
    runCalc('prv');
    const videoId = await prvVideoId(vid);
    await dbQuery(
        `INSERT INTO votes (user_id, video_id, category_id, start, "end", vote, "createdAt", "updatedAt") VALUES
         ('prv-legacy-voter', $1, $2, 1, 11, -1, now() - interval '2 days', now() - interval '2 days'),
         ('prv-legacy-voter', $1, $2, 1, 11,  1, now() - interval '1 day', now() - interval '1 day')`,
        [videoId, cat]
    );
    const authorBefore = await userRating('', author);

    await postVote('', { video_id: vid, user_id: 'prv-legacy-voter', category_id: cat, start: 1, end: 11, vote: -1 });
    const rows = await dbQuery('SELECT vote FROM votes WHERE video_id = $1', [videoId]);
    assert.deepEqual(rows.map(r => r.vote), [-1], 'one row left, the new vote');
    assert.equal((await getSegmentRow('', vid, cat, 1, 11)).rating, -1, 'segment table rating');
    assert.equal(await getJsonRating('', vid, cat, 1, 11), -1, 'JSON rating');
    assert.equal(await userRating('', author), authorBefore - 2, 'the author moved from the latest +1 to -1');
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
function batchRow(batch, { decided, finished = [], locked_by = null, state = 'available', reviews_needed = 1, priority = 'important' }) {
    return { batch, total: 3, decided, open: 3 - decided, reviews_needed, priority, finished, locked_by, locked_at: null, state };
}

// The importer locks a half-done batch on the md reviewer; tests that start
// from a free batch let them give it up.
async function giveUp(...batches) {
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query('UPDATE prv_review_batches SET locked_by = NULL, locked_at = NULL WHERE batch = ANY($1)', [batches]);
    } finally {
        await c.end();
    }
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

test('review import: md verdicts lock the unfinished batch on --reviewer, finishing releases it, a re-run does not re-lock', async () => {
    const batch = 'e2e-review-import-lock';
    const md = copyReviewFixture(batch);
    const r = runImport(md);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /locked on bayanovea: their verdicts leave the batch unfinished/);
    await withReviewRepo(async (repo) => {
        assert.deepEqual({ ...(await repo.getBatchProgress(batch, 'bayanovea')), locked_at: null },
            batchRow(batch, { decided: 2, locked_by: 'bayanovea', state: 'mine' }));
        await repo.releaseBatch(batch, 'bayanovea');
    });

    const rerun = runImport(md);
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.doesNotMatch(rerun.stdout, /locked on/);
    await withReviewRepo(async (repo) => assert.equal((await repo.getBatchProgress(batch, 'bayanovea')).locked_by, null));

    await withReviewRepo((repo) => repo.takeBatch(batch, 'bayanovea'));
    setVerdictLine(md, 'C7', 'sponsor');
    const done = runImport(md);
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /lock released: bayanovea has finished the batch/);
    await withReviewRepo(async (repo) => assert.deepEqual(await repo.getBatchProgress(batch, 'bayanovea'),
        batchRow(batch, { decided: 3, finished: ['bayanovea'], state: 'done' })));
});

test('review import: md verdicts into a batch locked by another reviewer fail and write nothing; skipped ones pass', async () => {
    const batch = 'e2e-review-import-lock-held';
    const theirs = runImport(copyReviewFixture(batch), ['--reviewer', 'gkshi']);
    assert.equal(theirs.status, 0, theirs.stderr);
    assert.match(theirs.stdout, /locked on gkshi/);

    const mineMd = copyReviewFixture(batch);
    setVerdictLine(mineMd, 'C7', 'sponsor');
    const r = runImport(mineMd);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /batch e2e-review-import-lock-held is locked by gkshi: bayanovea's md verdicts may not land there; nothing imported/);
    assert.deepEqual((await reviewState(batch)).verdicts.map(v => [v.item_code, v.reviewer]), [['C2', 'gkshi'], ['C5', 'gkshi']]);

    const skipped = runImport(copyReviewFixture(batch));
    assert.equal(skipped.status, 0, 'every md verdict is skipped, nothing would land');
    assert.match(skipped.stdout, /verdicts imported: 0\n/);
    await withReviewRepo(async (repo) => assert.equal((await repo.getBatchProgress(batch, 'gkshi')).locked_by, 'gkshi'));
});

test('review import: --priority sets the batch row (default important), an existing batch must match; the list sorts urgent first and shows the label', async () => {
    const opt = 'e2e-review-import-priority-opt';
    const urg = 'e2e-review-import-priority-urg';
    const plain = 'e2e-review-import-priority-plain';
    assert.equal(runImport(copyReviewFixture(opt), ['--priority', 'optional']).status, 0);
    assert.equal(runImport(copyReviewFixture(urg), ['--priority=urgent']).status, 0);
    assert.equal(runImport(copyReviewFixture(plain)).status, 0);
    const priorities = await dbQuery('SELECT batch, priority FROM prv_review_batches WHERE batch = ANY($1) ORDER BY batch', [[opt, plain, urg]]);
    assert.deepEqual(priorities, [{ batch: opt, priority: 'optional' }, { batch: plain, priority: 'important' }, { batch: urg, priority: 'urgent' }]);
    assert.equal(runImport(copyReviewFixture(opt), ['--priority', 'optional']).status, 0, 'same value passes');
    assert.equal(runImport(copyReviewFixture(opt)).status, 0, 'left out: not compared');
    const other = runImport(copyReviewFixture(opt), ['--priority', 'urgent']);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /batch e2e-review-import-priority-opt is optional, not urgent/);
    const bad = runImport(copyReviewFixture('e2e-review-import-priority-bad'), ['--priority', 'soon']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--priority must be one of urgent, important, optional/);
    await giveUp(opt, urg, plain);

    const list = (await request('GET', reviewPath('/admin/review', { format: 'json' }), null)).body.batches
        .filter(b => [opt, urg, plain].includes(b.batch));
    assert.deepEqual(list.map(b => [b.batch, b.priority]), [[urg, 'urgent'], [plain, 'important'], [opt, 'optional']], 'urgent first, optional last');
    const html = (await request('GET', reviewPath('/admin/review'), null)).body;
    for (const key of ['list_col_priority', 'priority_urgent', 'priority_important', 'priority_optional']) assert.ok(html.includes(RU(key)), key);
    assert.ok(html.indexOf(`/admin/review/${urg}?`) < html.indexOf(`/admin/review/${plain}?`) && html.indexOf(`/admin/review/${plain}?`) < html.indexOf(`/admin/review/${opt}?`), 'rows in priority order');
    for (const p of ['urgent', 'important', 'optional']) {
        assert.ok(html.includes(`class="priority-group priority-group-${p}"`), `divider row for ${p}`);
    }
    // Other tests leave batches in other sections, so look around this section's urgent row (the CSS mentions the class names too).
    const urgAt = html.indexOf(`/admin/review/${urg}?`);
    const urgentDivider = html.lastIndexOf('class="priority-group priority-group-urgent"', urgAt);
    const importantDivider = html.indexOf('class="priority-group priority-group-important"', urgAt);
    assert.ok(urgentDivider > -1 && importantDivider > -1 && importantDivider < html.indexOf(`/admin/review/${plain}?`), 'the urgent divider sits above its rows, the important one between them and the important rows');
    assert.ok(html.includes(`class="priority-row priority-row-optional"`), 'rows carry their priority class');
});

test('review import: --reviews and --exclude set the batch row; an existing batch must match; bad values fail', async () => {
    const batch = 'e2e-review-import-routing';
    const md = copyReviewFixture(batch);
    const r = runImport(md, ['--reviews', '2', '--exclude', 'gkshi']);
    assert.equal(r.status, 0, r.stderr);
    const row = async (b) => {
        const c = adminClient(TEST_DB);
        await c.connect();
        try {
            return (await c.query('SELECT reviews_needed, excluded FROM prv_review_batches WHERE batch = $1', [b])).rows[0];
        } finally {
            await c.end();
        }
    };
    assert.deepEqual(await row(batch), { reviews_needed: 2, excluded: ['gkshi'] });

    assert.equal(runImport(md).status, 0, 'options left out are not compared');
    assert.equal(runImport(md, ['--reviews=2', '--exclude=gkshi']).status, 0, 'same values pass');
    const other = runImport(md, ['--reviews', '1']);
    assert.equal(other.status, 1);
    assert.match(other.stderr, /batch e2e-review-import-routing needs 2 review\(s\), not 1/);
    const otherExcl = runImport(md, ['--exclude', 'gkshi,bayanovea']);
    assert.equal(otherExcl.status, 1);
    assert.match(otherExcl.stderr, /excludes \{gkshi\}, not \{bayanovea,gkshi\}/);
    assert.deepEqual(await row(batch), { reviews_needed: 2, excluded: ['gkshi'] });

    const fresh = 'e2e-review-import-routing-bad';
    for (const [args, re] of [
        [['--reviews', '0'], /--reviews needs a positive integer/],
        [['--reviews', 'two'], /--reviews needs a positive integer/],
        [['--exclude', ' , '], /--exclude needs reviewer codes/],
        [['--exclude'], /--exclude needs a value/],
        [['--max-items', '0'], /--max-items needs a positive integer/],
    ]) {
        const bad = runImport(copyReviewFixture(fresh), args);
        assert.equal(bad.status, 2, args.join(' '));
        assert.match(bad.stderr, re);
    }
    const unknown = runImport(copyReviewFixture(fresh), ['--exclude', 'e2e-nobody']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown reviewer e2e-nobody/);
    assert.equal(await row(fresh), undefined, 'nothing written');
    assert.equal((await reviewState(fresh)).items.length, 0);
});

test('review import: md verdicts of an excluded --reviewer fail and write nothing; skipped ones pass', async () => {
    const batch = 'e2e-review-import-excluded';
    await withReviewRepo((repo) => repo.createBatch(batch, { excluded: ['bayanovea'] }));
    const md = copyReviewFixture(batch);
    const r = runImport(md);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /batch e2e-review-import-excluded excludes bayanovea: their md verdicts may not land there; nothing imported/);
    assert.deepEqual(await reviewState(batch), { items: [], verdicts: [] });

    assert.equal(runImport(md, ['--reviewer', 'gkshi']).status, 0);
    const again = runImport(md);
    assert.equal(again.status, 0, 'every md verdict is skipped, nothing would land');
    assert.match(again.stdout, /verdicts imported: 0\n/);
    assert.deepEqual((await reviewState(batch)).verdicts.map(v => v.reviewer), ['gkshi', 'gkshi']);

    const fresh = 'e2e-review-import-excluded-fresh';
    const viaFlag = runImport(copyReviewFixture(fresh), ['--exclude', 'bayanovea']);
    assert.equal(viaFlag.status, 1);
    assert.match(viaFlag.stderr, /excludes bayanovea/);
    assert.deepEqual(await dbQuery('SELECT batch FROM prv_review_batches WHERE batch = $1', [fresh]), [], 'no batch row');
    assert.deepEqual(await reviewState(fresh), { items: [], verdicts: [] });
});

// Generated sheet of `n` items C1…Cn (five per video), md verdicts from
// `verdicts` ({ C3: 'sponsor' }); returns the md path. Same name and code → same stretch.
function writeReviewSheet(name, n, verdicts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-import-'));
    reviewTmpDirs.push(dir);
    const md = ['# Blind review sheet', ''];
    const key = ['item\tnative_id\tstart\tend\tcategories\truns_flagging'];
    for (let k = 1; k <= n; k++) {
        const nid = `-1_${Math.ceil(k / 5)}`;
        const start = 60 * k;
        md.push(`### C${k}. ${nid} · 1:00 – 1:10 (10 s)`, '', 'Proposed as: sponsor', '',
            `Link: https://example.invalid/video${nid}?t=${start}s`, '', '> cue', '', `Verdict: ${verdicts[`C${k}`] || ''}`, '');
        key.push(`C${k}\t${nid}\t${start}.0\t${start + 10}.0\tsponsor\trun-a`);
    }
    const mdPath = path.join(dir, `${name}.md`);
    fs.writeFileSync(mdPath, md.join('\n'));
    fs.writeFileSync(path.join(dir, `${name}.key.tsv`), key.join('\n') + '\n');
    return mdPath;
}

// [batch, items, first position, last position, reviews_needed, excluded, locked_by] per part of `sheet`.
async function sheetParts(sheet) {
    return (await dbQuery(
        `SELECT i.batch, count(*)::int AS n, min(i.position) AS lo, max(i.position) AS hi,
                b.reviews_needed, b.excluded, b.locked_by
           FROM prv_review_items i JOIN prv_review_batches b USING (batch)
          WHERE COALESCE(i.sheet, i.batch) = $1
          GROUP BY i.batch, b.reviews_needed, b.excluded, b.locked_by ORDER BY i.batch`, [sheet]))
        .map((r) => [r.batch, r.n, r.lo, r.hi, r.reviews_needed, r.excluded, r.locked_by]);
}

const firstVerdicts = (n, verdict = 'sponsor') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`C${i + 1}`, verdict]));

test('review import: a sheet over --max-items becomes balanced parts with per-part locks; re-import is idempotent; new items go to a new part', async () => {
    const sheet = 'e2e-review-parts';
    const r = runImport(writeReviewSheet(sheet, 70, firstVerdicts(30)), ['--reviews', '2']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`sheet ${sheet}: batch ${sheet}-p1 \\(24 items\\), batch ${sheet}-p2 \\(23 items\\), batch ${sheet}-p3 \\(23 items\\)`));
    assert.match(r.stdout, /items inserted: 70\n/);
    assert.match(r.stdout, /verdicts imported: 30\n/);
    assert.match(r.stdout, new RegExp(`batch ${sheet}-p2: locked on bayanovea: their verdicts leave the batch unfinished`));
    assert.equal((r.stdout.match(/locked on/g) || []).length, 1, 'p1 is finished, p3 has no verdicts');
    const split = [
        [`${sheet}-p1`, 24, 1, 24, 2, [], null],
        [`${sheet}-p2`, 23, 25, 47, 2, [], 'bayanovea'],
        [`${sheet}-p3`, 23, 48, 70, 2, [], null],
    ];
    assert.deepEqual(await sheetParts(sheet), split);
    assert.deepEqual(await dbQuery('SELECT DISTINCT sheet FROM prv_review_items WHERE batch LIKE $1', [`${sheet}-p%`]), [{ sheet }]);
    await withReviewRepo(async (repo) => {
        const states = [];
        for (const [batch] of split) states.push((await repo.getBatchProgress(batch, 'bayanovea')).state);
        assert.deepEqual(states, ['done', 'mine', 'available']);
    });

    const again = runImport(writeReviewSheet(sheet, 70, firstVerdicts(30)));
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /items inserted: 0\nitems already present: 70 /);
    assert.match(again.stdout, /verdicts imported: 0\nverdicts skipped, item already has one: 30 /);
    assert.doesNotMatch(again.stdout, /locked on|lock released/);
    assert.deepEqual(await sheetParts(sheet), split);

    const otherReviews = runImport(writeReviewSheet(sheet, 70), ['--reviews', '1']);
    assert.equal(otherReviews.status, 1);
    assert.match(otherReviews.stderr, new RegExp(`batch ${sheet}-p1 needs 2 review\\(s\\), not 1`));

    // Five more items: a new part with the first part's settings; C40 lands in p2 (held by bayanovea), C72 in p4.
    const grown = runImport(writeReviewSheet(sheet, 75, { ...firstVerdicts(30), C40: 'not an ad', C72: 'sponsor' }));
    assert.equal(grown.status, 0, grown.stderr);
    assert.match(grown.stdout, new RegExp(`batch ${sheet}-p4 \\(5 items\\)`));
    assert.match(grown.stdout, /items inserted: 5\nitems already present: 70 /);
    assert.match(grown.stdout, /verdicts imported: 2\n {2}C40 not_ad\n {2}C72 sponsor\n/);
    assert.match(grown.stdout, new RegExp(`batch ${sheet}-p4: locked on bayanovea`));
    assert.deepEqual(await sheetParts(sheet), [...split, [`${sheet}-p4`, 5, 71, 75, 2, [], 'bayanovea']]);
    const c40 = await dbQuery(
        `SELECT i.batch, v.verdict FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id
          WHERE i.sheet = $1 AND i.item_code = 'C40'`, [sheet]);
    assert.deepEqual(c40, [{ batch: `${sheet}-p2`, verdict: 'not_ad' }]);

    // Finishing a part through the md releases that part only.
    const finished = runImport(writeReviewSheet(sheet, 75, { ...firstVerdicts(47), C72: 'sponsor' }));
    assert.equal(finished.status, 0, finished.stderr);
    assert.match(finished.stdout, new RegExp(`batch ${sheet}-p2: lock released: bayanovea has finished the batch`));
    assert.deepEqual((await sheetParts(sheet)).map((p) => p[6]), [null, null, null, 'bayanovea']);
});

test('review import: refusal rules hold per part (held by another reviewer, excluded)', async () => {
    const sheet = 'e2e-review-parts-held';
    assert.equal(runImport(writeReviewSheet(sheet, 40, { C1: 'sponsor' })).status, 0);
    assert.deepEqual((await sheetParts(sheet)).map((p) => [p[0], p[1], p[6]]),
        [[`${sheet}-p1`, 20, 'bayanovea'], [`${sheet}-p2`, 20, null]]);

    const held = runImport(writeReviewSheet(sheet, 40, { C2: 'sponsor', C30: 'sponsor' }), ['--reviewer', 'gkshi']);
    assert.equal(held.status, 1, held.stdout);
    assert.match(held.stderr, new RegExp(`batch ${sheet}-p1 is locked by bayanovea: gkshi's md verdicts may not land there; nothing imported`));
    assert.deepEqual(await dbQuery(
        `SELECT v.reviewer FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id WHERE i.sheet = $1`, [sheet]),
        [{ reviewer: 'bayanovea' }], 'nothing written, the free part included');

    const free = runImport(writeReviewSheet(sheet, 40, { C30: 'sponsor' }), ['--reviewer', 'gkshi']);
    assert.equal(free.status, 0, free.stderr);
    assert.match(free.stdout, new RegExp(`batch ${sheet}-p2: locked on gkshi`));
    assert.deepEqual((await sheetParts(sheet)).map((p) => p[6]), ['bayanovea', 'gkshi']);

    const excl = 'e2e-review-parts-excluded';
    assert.equal(runImport(writeReviewSheet(excl, 40), ['--exclude', 'gkshi']).status, 0);
    assert.deepEqual((await sheetParts(excl)).map((p) => p[5]), [['gkshi'], ['gkshi']]);
    const r = runImport(writeReviewSheet(excl, 40, { C35: 'sponsor' }), ['--reviewer', 'gkshi']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`batch ${excl}-p2 excludes gkshi: their md verdicts may not land there; nothing imported`));

    // A part name that already holds another sheet's items is refused.
    assert.equal(runImport(writeReviewSheet('e2e-review-parts-clash-p1', 3)).status, 0);
    const clash = runImport(writeReviewSheet('e2e-review-parts-clash', 40));
    assert.equal(clash.status, 1, clash.stdout);
    assert.match(clash.stderr, /batch e2e-review-parts-clash-p1 already holds items of another sheet; nothing imported/);
    assert.deepEqual(await sheetParts('e2e-review-parts-clash'), []);

    const max = runImport(copyReviewFixture('e2e-review-parts-max'), ['--max-items', '2']);
    assert.equal(max.status, 0, max.stderr);
    assert.match(max.stdout, /sheet e2e-review-parts-max: batch e2e-review-parts-max-p1 \(2 items\), batch e2e-review-parts-max-p2 \(1 items\)/);
});

test('review import: rows of an older image (no sheet) are found by sheet, and its inserts never duplicate a sheet\'s codes', async () => {
    // main's importer: no `sheet` column, ON CONFLICT on (batch, item_code).
    const oldInsert = (batch, code, position, start) => dbQuery(
        `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed, link, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'sponsor', 'https://example.invalid/x', CURRENT_TIMESTAMP)
         ON CONFLICT (batch, item_code) DO NOTHING RETURNING id`, [batch, code, position, ...start]);
    const sheet = 'e2e-review-old-image';
    const c2 = ['-1_456000901', 262.4, 269.2];
    assert.equal((await oldInsert(sheet, 'C2', 2, c2)).length, 1);
    assert.equal((await oldInsert(sheet, 'C2', 2, c2)).length, 0, 'its own ON CONFLICT still works');

    const r = runImport(copyReviewFixture(sheet));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /items inserted: 2\nitems already present: 1 \(C2\)/);
    assert.match(r.stdout, /verdicts imported: 2\n/);
    assert.deepEqual(await dbQuery(
        'SELECT item_code, batch, sheet FROM prv_review_items WHERE COALESCE(sheet, batch) = $1 ORDER BY position', [sheet]), [
        { item_code: 'C2', batch: sheet, sheet: null },
        { item_code: 'C5', batch: `${sheet}-p2`, sheet },
        { item_code: 'C7', batch: `${sheet}-p2`, sheet },
    ], 'the new items go to a new part');

    // An older image importing a split sheet under its plain name fails instead of duplicating C1.
    const split = 'e2e-review-old-image-split';
    assert.equal(runImport(writeReviewSheet(split, 40)).status, 0);
    await assert.rejects(oldInsert(split, 'C1', 1, ['-1_1', 60, 70]), /prv_review_items_sheet_item_code/);

    // Boot over rows without a sheet.
    const sync = spawnSync('node', ['scripts/sync-db.js'], {
        cwd: APP_DIR, env: { ...process.env, DB_NAME: TEST_DB, DB_HOST, DB_PORT: String(DB_PORT) }, encoding: 'utf8' });
    assert.equal(sync.status, 0, sync.stderr);
});

function runSplit(...args) {
    const r = spawnSync('node', ['scripts/split-review-batch.js', ...args], {
        cwd: APP_DIR,
        env: { ...process.env, DB_NAME: TEST_DB, DB_HOST, DB_PORT: String(DB_PORT) },
        encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('review split: a batch over the limit becomes balanced parts; verdicts, settings and per-part states carry over; refusals', async () => {
    const sheet = 'e2e-review-split';
    const excl = 'e2e-split-excluded';
    await withReviewRepo((repo) => repo.createReviewer(excl));
    try {
        const imp = runImport(writeReviewSheet(sheet, 64, firstVerdicts(64)), ['--max-items', '64', '--reviews', '2', '--exclude', excl, '--priority', 'optional']);
        assert.equal(imp.status, 0, imp.stderr);
        const whole = [[sheet, 64, 1, 64, 2, [excl], null]];
        assert.deepEqual(await sheetParts(sheet), whole);

        const ids = Object.fromEntries((await dbQuery('SELECT item_code, id FROM prv_review_items WHERE batch = $1', [sheet]))
            .map((r) => [r.item_code, r.id]));
        await withReviewRepo(async (repo) => {
            await repo.takeBatch(sheet, 'gkshi');
            for (let k = 1; k <= 30; k++) {
                await repo.recordVerdict({ item_id: ids[`C${k}`], verdict: 'not_ad', reviewer: 'gkshi', source: 'page' });
            }
        });
        const verdicts = () => dbQuery('SELECT id, item_id, reviewer, verdict FROM prv_review_verdicts WHERE item_id = ANY($1) ORDER BY id',
            [Object.values(ids)]);
        const before = await verdicts();
        assert.equal(before.length, 94);

        const locked = runSplit(sheet);
        assert.equal(locked.status, 1, locked.stdout);
        assert.match(locked.stderr, new RegExp(`split failed: batch ${sheet} is locked by gkshi: release it on the page first`));
        await withReviewRepo((repo) => repo.releaseBatch(sheet, 'gkshi'));
        const within = runSplit(sheet, '--max-items', '64');
        assert.equal(within.status, 1, within.stdout);
        assert.match(within.stderr, new RegExp(`batch ${sheet} has 64 items, within the limit of 64`));
        assert.deepEqual(await sheetParts(sheet), whole);

        const r = runSplit(sheet);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), `batch ${sheet} (64 items, sheet ${sheet}) split into `
            + `${sheet}-p1 (22 items), ${sheet}-p2 (21 items), ${sheet}-p3 (21 items)`);
        assert.deepEqual(await sheetParts(sheet), [
            [`${sheet}-p1`, 22, 1, 22, 2, [excl], null],
            [`${sheet}-p2`, 21, 23, 43, 2, [excl], null],
            [`${sheet}-p3`, 21, 44, 64, 2, [excl], null],
        ]);
        assert.deepEqual(await dbQuery('SELECT batch FROM prv_review_batches WHERE batch = $1', [sheet]), [], 'old batch row gone');
        assert.deepEqual((await dbQuery('SELECT priority FROM prv_review_batches WHERE batch LIKE $1 ORDER BY batch', [`${sheet}-p%`])).map((r) => r.priority),
            ['optional', 'optional', 'optional'], 'parts keep the priority');
        assert.deepEqual(await verdicts(), before, 'verdicts stay on their items');
        const parts = [1, 2, 3].map((k) => `${sheet}-p${k}`);
        await withReviewRepo(async (repo) => {
            const states = async (reviewer) => (await repo.listBatches({ reviewer, all: true }))
                .filter((b) => parts.includes(b.batch)).map((b) => [b.batch, b.state, b.decided]);
            assert.deepEqual(await states('gkshi'), [[parts[0], 'done', 22], [parts[1], 'available', 8], [parts[2], 'available', 0]]);
            assert.deepEqual(await states('bayanovea'), [[parts[0], 'done', 22], [parts[1], 'done', 21], [parts[2], 'done', 21]]);
            assert.deepEqual((await states(excl)).map((s) => s[1]), ['closed', 'closed', 'closed']);
        });

        const again = runImport(writeReviewSheet(sheet, 64, firstVerdicts(64)));
        assert.equal(again.status, 0, again.stderr);
        assert.match(again.stdout, /items inserted: 0\nitems already present: 64 /);

        const twice = runSplit(sheet);
        assert.equal(twice.status, 1, twice.stdout);
        assert.match(twice.stderr, new RegExp(`batch ${sheet} is gone: already split into ${parts.join(', ')}`));
        assert.equal((await sheetParts(sheet)).length, 3);

        const clash = 'e2e-review-clash';
        assert.equal(runImport(writeReviewSheet(clash, 40), ['--max-items', '40']).status, 0);
        await withReviewRepo((repo) => repo.createBatch(`${clash}-p2`));
        const refused = runSplit(clash);
        assert.equal(refused.status, 1, refused.stdout);
        assert.match(refused.stderr, new RegExp(`batch ${clash}-p2 already exists; nothing split`));
        assert.deepEqual(await sheetParts(clash), [[clash, 40, 1, 40, 1, [], null]]);

        const unknown = runSplit('e2e-review-no-such-batch');
        assert.equal(unknown.status, 1);
        assert.match(unknown.stderr, /unknown batch e2e-review-no-such-batch/);
        for (const args of [[], ['x', '--max-items', '0'], ['x', 'y'], ['x', '--bogus']]) {
            assert.equal(runSplit(...args).status, 2, args.join(' '));
        }
    } finally {
        // Later tests list the seeded reviewers only.
        await withReviewRepo((repo, sequelize) =>
            sequelize.query('DELETE FROM prv_review_reviewers WHERE code = :code', { replacements: { code: excl } }));
    }
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

test('schema one-off: batch assignee → exclusions and locks, assignee cleared; a second boot changes nothing, an old image\'s assignee is re-migrated', async () => {
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
            DROP COLUMN reviews_needed, DROP COLUMN excluded, DROP COLUMN locked_by, DROP COLUMN locked_at`);
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
        assert.deepEqual(columns, ['assignee', 'batch', 'created_at', 'excluded', 'locked_at', 'locked_by', 'priority', 'reviews_needed']);
        const batches = async () => (await c.query(
            'SELECT batch, assignee, reviews_needed, excluded, locked_by, locked_at FROM prv_review_batches ORDER BY batch')).rows;
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
        assert.ok(after.every(b => b.assignee === null));
        assert.deepEqual(await batches(), after, 'second boot is a no-op');

        // Rollback: a pre-2026-10-20 image's boot insert and its batch filter still run.
        await c.query(
            `INSERT INTO prv_review_items (batch, item_code, position, native_id, start, "end", proposed)
             VALUES ('old-image', 'C1', 1, '-1_1', 10, 20, 'sponsor')`);
        await c.query(
            `INSERT INTO prv_review_batches (batch, assignee)
             SELECT DISTINCT batch, 'bayanovea' FROM prv_review_items
             ON CONFLICT DO NOTHING`);
        assert.equal((await c.query(
            `SELECT count(*)::int AS n FROM prv_review_batches b WHERE b.assignee IS NULL OR b.assignee = 'gkshi'`)).rows[0].n, 8);
        await c.query(`UPDATE prv_review_batches SET assignee = 'gkshi' WHERE batch = 'anyone'`);

        // Roll-forward re-migrates only those rows.
        r = sync();
        assert.equal(r.status, 0, `sync-db failed: ${r.stderr}`);
        const again = await batches();
        const changed = again.filter(b => !after.some(a => JSON.stringify(a) === JSON.stringify(b)));
        assert.deepEqual(changed.map(b => [b.batch, b.assignee, b.excluded, b.locked_by, b.locked_at != null]), [
            ['anyone', null, ['bayanovea'], 'gkshi', true],
            ['old-image', null, [], 'bayanovea', true],
        ]);
        assert.equal(again.length, 9);
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
    await giveUp(batch);

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
        await giveUp(one, two, excl);

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
            assert.equal(mayDecide(await state(one, 'gkshi')), true);
            assert.equal(mayDecide(await state(one, 'bayanovea')), false);
            await assert.rejects(repo.releaseBatch(one, 'bayanovea'), conflict('locked', 'gkshi'), 'not the holder, no force');

            // gkshi decides C2 and gives up: the verdict stays, the lock goes.
            await decide(one, ['C2'], 'gkshi');
            assert.equal(await repo.releaseIfFinished(one, 'gkshi'), false, 'unfinished → lock kept');
            assert.deepEqual(await repo.releaseBatch(one, 'gkshi'), unlocked(one));
            assert.deepEqual(await repo.releaseBatch(one, 'gkshi'), unlocked(one), 'releasing a free batch is a no-op');
            assert.equal((await repo.getItem(one, 'C2')).verdict.reviewer, 'gkshi');
            assert.equal(await state(one, 'gkshi'), 'available', 'may come back while the batch still needs its review');

            // bayanovea takes it and finishes: lock cleared, the one review is done.
            await repo.takeBatch(one, 'bayanovea');
            await decide(one, ['C7'], 'bayanovea');
            assert.equal(await repo.releaseIfFinished(one, 'bayanovea'), true);
            assert.deepEqual(await repo.getBatchProgress(one, 'bayanovea'),
                batchRow(one, { decided: 3, finished: ['bayanovea'], state: 'done' }));
            assert.equal(mayDecide(await state(one, 'bayanovea')), true, 'may fix their own finished batch');
            await assert.rejects(repo.takeBatch(one, 'bayanovea'), conflict('done'));
            assert.equal(await state(one, NEWCOMER), 'closed', 'review count met → closed to newcomers');
            await assert.rejects(repo.takeBatch(one, NEWCOMER), conflict('closed'));
            // gkshi gave up halfway: once the batch has its review, no coming back.
            assert.equal(await state(one, 'gkshi'), 'closed');
            await assert.rejects(repo.takeBatch(one, 'gkshi'), conflict('closed'));

            // Two reviews needed: after bayanovea finishes, others may still take it; after the second, nobody new.
            await repo.takeBatch(two, 'bayanovea');
            await decide(two, ['C7'], 'bayanovea');
            assert.equal(await repo.releaseIfFinished(two, 'bayanovea'), true);
            assert.equal(await state(two, 'bayanovea'), 'done');
            assert.equal(await state(two, NEWCOMER), 'available');
            await repo.takeBatch(two, 'gkshi');
            await decide(two, ['C2'], 'gkshi');
            assert.deepEqual(await repo.releaseBatch(two, 'bayanovea', { force: true }), unlocked(two), 'force release');
            assert.equal(await state(two, 'gkshi'), 'available', 'back after a force release: still one review short');
            await repo.takeBatch(two, 'gkshi');
            await decide(two, ['C5', 'C7'], 'gkshi');
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

function savedFlash(item, verdict, { track = false, flagged = 'run-kbd', bounds = null } = {}) {
    return RU.text('js_saved', {
        item, verdict: RU.text(`verdict_${verdict}`), track: track ? RU.text('js_saved_track') : '', flagged,
        bounds: bounds ? RU.text('js_saved_bounds', { start: bounds[0], end: bounds[1] }) : '',
    });
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
    await giveUp(batch);

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
    assert.deepEqual(d.body, { item_id: item.id, item_code: 'C7', verdict: 'self_promotion', bounds: null,
        effective_bounds: { start: item.start, end: item.end, reviewer: null, source: null },
        track_mismatch: false, flagged_by: [REVIEW_RUN], next_item: null, next_player_link: null, ai_applied: false });

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
    await giveUp(batch);
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
        tagName, id, value, isContentEditable: false, textContent: '', className: '', disabled: false, listeners: {},
        focus() { doc.activeElement = this; },
        blur() { if (doc.activeElement === this) doc.activeElement = body; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    });
    // An input or button of the page as rendered: value and disabled from its tag.
    const control = (tagName, id) => {
        const tag = (html.match(new RegExp(`<${tagName.toLowerCase()}\\b[^>]*\\bid="${id}"[^>]*>`)) || [''])[0];
        const value = (tag.match(/\bvalue="([^"]*)"/) || [, ''])[1];
        return Object.assign(field(tagName, id, htmlUnescape(value)), { disabled: /\sdisabled(?=[\s>])/.test(tag) });
    };
    const comment = html.match(/<textarea[^>]*\bid="comment"[^>]*>([\s\S]*?)<\/textarea>/);
    const els = {
        status: field('DIV', 'status'),
        'track-flag': Object.assign(field('INPUT', 'track-flag'), { checked: /id="track-flag" checked/.test(html) }),
        comment: field('TEXTAREA', 'comment', comment ? htmlUnescape(comment[1]) : ''),
        'save-btn': field('BUTTON', 'save-btn'),
        'bound-start': control('INPUT', 'bound-start'),
        'bound-end': control('INPUT', 'bound-end'),
        'bounds-clear': control('BUTTON', 'bounds-clear'),
    };
    if (html.includes('id="player-link"')) els['player-link'] = field('A', 'player-link');
    if (html.includes('id="lock-status"')) els['lock-status'] = field('SPAN', 'lock-status');
    if (html.includes('id="auto-advance"')) els['auto-advance'] = Object.assign(field('INPUT', 'auto-advance'), { checked: true });
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

test('review page: bounds from the keyboard: t focuses the start, typed m:ss saves with the verdict, the same bounds again is no change, a non-keep verdict clears them, half-filled or short bounds are refused', async () => {
    const batch = 'e2e-review-bounds-kbd';
    await seedKeyboardBatch(batch, 2);
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const itemPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;
    let { page, html } = await openKeyboardPage(itemPath('C1'), storages);
    assert.ok(html.includes(RU('bounds_hint')) && html.includes(RU('rules_bounds_html')), 'hint and boundary rule');
    assert.match(html, /<kbd>t<\/kbd>/, 'the t hotkey in the hotkeys line');

    page.key('1');
    page.key('t');
    assert.equal(page.active(), 'bound-start');
    page.els['bound-start'].value = '0:08';
    page.els['bound-end'].value = '0:20';
    page.key('Escape');
    await saveAndFollow(page);
    const [v] = await dbQuery(`SELECT v.verdict, v.start, v."end", v.bounds_source FROM prv_review_verdicts v
        JOIN prv_review_items i ON i.id = v.item_id WHERE i.batch = $1 AND i.item_code = 'C1'`, [batch]);
    assert.deepEqual(v, { verdict: 'sponsor', start: 8, end: 20, bounds_source: 'typed' });

    ({ page } = await openKeyboardPage(itemPath('C2'), storages));
    assert.equal(page.els.status.textContent, savedFlash('C1', 'sponsor', { bounds: ['0:08', '0:20'] }));
    page.key('1');
    page.els['bound-start'].value = '0:30';
    page.key('Enter');
    assert.deepEqual([page.els.status.textContent, page.els.status.className], [RU.text('js_bounds_both'), 'status error']);
    page.els['bound-end'].value = '0:32';
    page.key('Enter');
    assert.equal(page.els.status.textContent, RU.text('error_bounds_short'));
    page.key('3');
    assert.deepEqual([page.els['bound-start'].value, page.els['bound-end'].value, page.els['bound-start'].disabled], ['', '', true],
        'not an ad: no bounds');

    ({ page, html } = await openKeyboardPage(itemPath('C1'), storages));
    assert.deepEqual([page.els['bound-start'].value, page.els['bound-end'].value], ['0:08', '0:20'], 'pre-filled from the own verdict');
    assert.ok(html.includes(RU('item_corrected', { start: '0:08', end: '0:20', name: REVIEWER })));
    page.key('Enter');
    assert.equal(page.els.status.textContent, noChangeText('C1', 'sponsor'));
    page.els['bound-end'].value = '0:21';
    await saveAndFollow(page);
    const rows = await dbQuery(`SELECT v.start, v."end" FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id
        WHERE i.batch = $1 AND i.item_code = 'C1' ORDER BY v.id`, [batch]);
    assert.deepEqual(rows.map(r => [r.start, r.end]), [[8, 20], [8, 21]], 'a bounds-only change saves');
});

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
    // A videos row shorter than C3's start (30 s): the page warns on C3 only.
    await (async () => {
        const c = adminClient(TEST_DB); await c.connect();
        await c.query(`DELETE FROM prv_review_video_flags WHERE native_id = '-1_3'`);
        await c.query(`DELETE FROM videos WHERE native_id = '-1_3'`);
        await c.query(`INSERT INTO videos (native_id, duration, "createdAt", "updatedAt") VALUES ('-1_3', 25, NOW(), NOW())`);
        await c.end();
    })();

    // 5 toggles the box; the flag is not a verdict (Enter still asks for one).
    let { page, html } = await openKeyboardPage(itemPath('C1'), storages);
    assert.ok(html.includes(RU('track_flag')));
    assert.ok(html.includes(RU('flags_hint')));
    assert.ok(!html.includes(RU('item_beyond_video_warn', { seconds: 25 })), 'C1 (10 s) is inside the video');
    const c3 = (await request('GET', itemPath('C3') + '&format=json', null)).body;
    assert.equal(c3.item.beyond_video_s, 25);
    assert.ok((await request('GET', itemPath('C3'), null)).body.includes(RU('item_beyond_video_warn', { seconds: 25 })));
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
    await giveUp(mine, theirs, anyone, excluded);
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
    assert.match(html, /id="track-flag" onchange="setStatus\(''\)" disabled>/);
    assert.match(html, /<textarea id="comment" style="width:100%" disabled>/);
    page.key('1');
    assert.deepEqual(page.selected(), []);
    assert.equal(page.els.status.textContent, RU.text('js_read_only'));
    page.els.status.textContent = '';
    page.key('5');
    assert.equal(page.els['track-flag'].checked, false);
    assert.equal(page.els.status.textContent, RU.text('js_read_only'));
    page.key('Enter');
    await sleep(20);
    assert.equal(page.navigatedTo, null);
    assert.equal(await countReviewVerdicts(batch), 0);
    const late = (await openKeyboardPage(itemPath('C1', 'gkshi'), storages)).page;

    // Take it from the banner → reload as holder.
    assert.equal(await runLock(page, 'take', false), itemPath('C1'));
    // gkshi's page still offers "Take it": the take fails in place and names the holder.
    assert.equal(await runLock(late, 'take', false), null);
    assert.equal(late.els['lock-status'].textContent, RU.text('conflict_locked', { name: REVIEWER }));
    assert.equal(late.els['lock-status'].className, 'status error');
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

test('review page: a lock idle for 12 h (no verdict from its holder) is released on the next request; a recent verdict keeps it', async () => {
    const idle = 'e2e-review-idle';
    const busy = 'e2e-review-idle-busy';
    await seedKeyboardBatch(idle, 3);
    await seedKeyboardBatch(busy, 3);
    const json = async (batch, who) => (await request('GET', reviewPath(`/admin/review/${batch}`, { reviewer: who, format: 'json' }), null)).body;
    const decide = async (batch, who = REVIEWER) =>
        decideReview({ item_id: (await json(batch, who)).item.id, verdict: 'not_ad', reviewer: who });
    const age = async (sql, params) => {
        const c = adminClient(TEST_DB);
        await c.connect();
        try { await c.query(sql, params); } finally { await c.end(); }
    };
    assert.equal((await decide(busy)).status, 201);
    await age(`UPDATE prv_review_batches SET locked_at = NOW() - INTERVAL '13 hours' WHERE batch = ANY($1)`, [[idle, busy]]);
    await age(`UPDATE prv_review_verdicts v SET decided_at = NOW() - INTERVAL '11 hours'
                 FROM prv_review_items i WHERE i.id = v.item_id AND i.batch = $1`, [busy]);

    let row = (await json(idle, 'gkshi')).batch;
    assert.equal(row.state, 'available', 'taken 13 h ago, no verdict since → free for anyone');
    assert.equal(row.locked_by, null);
    assert.equal((await json(busy, 'gkshi')).batch.state, 'locked', 'a verdict 11 h ago keeps the lock');

    const late = await decide(idle);
    assert.equal(late.status, 409, 'the former holder must take it again');
    assert.equal(late.body.reason, 'available');
    await takeReview(idle);
    assert.equal((await decide(idle)).status, 201);

    await age(`UPDATE prv_review_verdicts v SET decided_at = NOW() - INTERVAL '13 hours'
                 FROM prv_review_items i WHERE i.id = v.item_id AND i.batch = $1`, [busy]);
    row = (await json(busy, REVIEWER)).batch;
    assert.equal(row.state, 'available', 'last verdict 13 h ago → released');
    assert.equal(row.decided, 1, 'verdicts stay');
});

test('review page: closed and done over HTTP (409 with the translated reason, banner without a button)', async () => {
    const batch = 'e2e-review-closed';
    await withReviewRepo((repo) => repo.createBatch(batch, { excluded: [REVIEWER] }));
    await seedKeyboardBatch(batch, 2, { holder: null });
    const itemPath = `/admin/review/${batch}?item=C1&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;
    const c1 = (await getReview(batch, { item: 'C1', format: 'json' })).body.item;
    const conflict = (reason) => ({ reason, locked_by: null, message: RU.text(`conflict_${reason}`) });

    let res = await lockReview('take', batch, { reviewer: REVIEWER });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, conflict('closed'));
    res = await decideReview({ item_id: c1.id, verdict: 'sponsor', reviewer: REVIEWER });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, conflict('closed'));
    const { page, html } = await openKeyboardPage(itemPath, { local: memoryStorage(), session: memoryStorage() });
    assert.ok(html.includes('class="card lock lock-closed"') && html.includes(RU('lock_closed')));
    assert.ok(!html.includes('id="lock-btn"'), 'nothing to take or give up');
    assert.match(html, /id="save-btn" onclick="save\(\)" disabled>/);
    assert.match(html, /<textarea id="comment" style="width:100%" disabled>/);
    page.key('2');
    assert.deepEqual(page.selected(), []);
    assert.equal(page.els.status.textContent, RU.text('js_read_only'));

    await takeReview(batch, 'gkshi');
    for (const code of ['C1', 'C2']) {
        const item = (await getReview(batch, { item: code, reviewer: 'gkshi', format: 'json' })).body.item;
        assert.equal((await decideReview({ item_id: item.id, verdict: 'not_ad', reviewer: 'gkshi' })).status, 201);
    }
    res = await lockReview('take', batch, { reviewer: 'gkshi' });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, conflict('done'));
    assert.equal(await countReviewVerdicts(batch), 2);
});

test('review page: decide checks the lock under the batch row lock (a release in between → 409, nothing written)', async () => {
    const batch = 'e2e-review-decide-lock';
    await seedKeyboardBatch(batch, 2);
    const c1 = (await getReview(batch, { item: 'C1', format: 'json' })).body.item;
    const flagsBefore = (await videoFlags(c1.native_id)).length;
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM prv_review_batches WHERE batch = $1 FOR UPDATE', [batch]);
        const pending = decideReview({ item_id: c1.id, verdict: 'sponsor', reviewer: REVIEWER, track_mismatch: true });
        await waitForQueryBlockedOnLock(`prv_review_batches WHERE batch = '${batch}' FOR UPDATE`);
        // A force release and gkshi's take land while the save waits.
        await c.query("UPDATE prv_review_batches SET locked_by = 'gkshi', locked_at = CURRENT_TIMESTAMP WHERE batch = $1", [batch]);
        await c.query('COMMIT');
        const res = await pending;
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { reason: 'locked', locked_by: 'gkshi', message: RU.text('conflict_locked', { name: 'gkshi' }) });
    } finally {
        await c.end();
    }
    assert.equal(await countReviewVerdicts(batch), 0);
    assert.equal((await videoFlags(c1.native_id)).length, flagsBefore, 'no flag row either');
});

test('review page: a take waiting on an import that completes a free batch sees its verdict (409 closed, no lock)', async () => {
    const batch = 'e2e-review-take-after-final';
    await seedKeyboardBatch(batch, 1, { holder: null });
    const c1 = (await getReview(batch, { item: 'C1', format: 'json' })).body.item;
    const c = adminClient(TEST_DB);
    await c.connect();
    try {
        // REVIEWER's md verdict, lock and finish release, as the importer's transaction writes them.
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM prv_review_batches WHERE batch = $1 FOR UPDATE', [batch]);
        await c.query(`INSERT INTO prv_review_verdicts (item_id, verdict, reviewer, source) VALUES ($1, 'not_ad', $2, 'import')`, [c1.id, REVIEWER]);
        await c.query('UPDATE prv_review_batches SET locked_by = $2, locked_at = CURRENT_TIMESTAMP WHERE batch = $1', [batch, REVIEWER]);
        await c.query('UPDATE prv_review_batches SET locked_by = NULL, locked_at = NULL WHERE batch = $1', [batch]);
        const pending = lockReview('take', batch, { reviewer: 'gkshi' });
        await waitForQueryBlockedOnLock(`batch = '${batch}'`);
        await c.query('COMMIT');
        const res = await pending;
        assert.equal(res.status, 409);
        assert.deepEqual(res.body, { reason: 'closed', locked_by: null, message: RU.text('conflict_closed') });
    } finally {
        await c.end();
    }
    assert.deepEqual(await dbQuery('SELECT locked_by FROM prv_review_batches WHERE batch = $1', [batch]), [{ locked_by: null }]);
});

test('review page: create reviewer (form / JSON) → picker → batch list → item page → take → decide, a Cyrillic name with a space round-trips', async () => {
    const NAME = 'Анна Петрова-2';
    const batch = 'e2e-review-create-reviewer';
    const enc = encodeURIComponent(NAME);
    const created = [NAME, 'Zoë Ng', 'Тест', 'тест'];
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

        // Two concurrent names that differ only in letter case: exactly one is stored.
        const raced = await withReviewRepo((repo) => Promise.all([repo.createReviewer('Тест'), repo.createReviewer('тест')]));
        assert.equal(raced.filter(code => code === null).length, 1, JSON.stringify(raced));
        assert.ok(['Тест', 'тест'].includes(raced.find(code => code !== null)), JSON.stringify(raced));
    } finally {
        // Later tests list the seeded reviewers only; a boot would rewrite these verdicts to bayanovea.
        await withReviewRepo(async (repo, sequelize) => {
            await sequelize.query('DELETE FROM prv_review_verdicts WHERE reviewer IN (:created)', { replacements: { created } });
            await sequelize.query('DELETE FROM prv_review_reviewers WHERE code IN (:created)', { replacements: { created } });
        });
    }
});

test('review page: with auto-advance off a save stays on the item; the choice is kept in localStorage', async () => {
    const batch = 'e2e-review-auto-advance';
    await seedKeyboardBatch(batch, 3);
    const storages = { local: memoryStorage(), session: memoryStorage() };
    const itemPath = (code) => `/admin/review/${batch}?item=${code}&reviewer=${REVIEWER}&verifyBearerToken=${MOD_AUTH}`;

    let { page, html } = await openKeyboardPage(itemPath('C1'), storages);
    assert.ok(html.includes(RU('auto_advance')));
    assert.equal(page.els['auto-advance'].checked, true, 'on by default');
    vm.runInContext('setAutoAdvance(false)', page.ctx);
    assert.equal(storages.local.getItem('adminReview.autoAdvance'), 'off');
    page.key('1');
    page.opened.length = 0;
    assert.equal(await saveAndFollow(page), itemPath('C1'), 'reloads the saved item');
    assert.deepEqual(page.opened, [], 'no new tab, no player');
    assert.equal(page.opener.closed, false, 'the item\'s player tab stays');

    // The next page load (and the next item) keeps the choice; j / k still switch.
    ({ page } = await openKeyboardPage(itemPath('C1'), storages));
    assert.equal(page.els['auto-advance'].checked, false);
    assert.equal(page.els.status.textContent, savedFlash('C1', 'sponsor'));
    page.key('j');
    assert.equal(page.reviewUrl(), itemPath('C2'));
    ({ page } = await openKeyboardPage(itemPath('C2'), storages));
    page.key('2');
    assert.equal(await saveAndFollow(page), itemPath('C2'));

    // Back on: a save moves on again.
    vm.runInContext('setAutoAdvance(true)', page.ctx);
    assert.equal(storages.local.getItem('adminReview.autoAdvance'), null);
    ({ page } = await openKeyboardPage(itemPath('C2'), storages));
    assert.equal(page.els['auto-advance'].checked, true);
    page.key('3');
    assert.equal(await saveAndFollow(page), itemPath('C3'));
    assert.equal(page.opener.closed, true);
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

    // A force release while the page is open: the save shows the 409 message and stays.
    ({ page } = await openKeyboardPage(itemPath('C2'), storages));
    assert.equal((await lockReview('release', batch, { reviewer: 'gkshi', force: true })).status, 200);
    page.key('2');
    page.key('Enter');
    for (let i = 0; i < 200 && page.els.status.className !== 'status error'; i++) await sleep(10);
    assert.equal(page.els.status.textContent, RU.text('conflict_available'));
    assert.equal(page.navigatedTo, null);
    assert.equal(page.els['save-btn'].disabled, false);
    assert.equal((await reviewState(batch)).verdicts.length, 2);
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
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);

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

test('review page: onboarding block, closed by default, on the batch list and the item page in both languages', async () => {
    const batch = 'e2e-review-onboarding';
    await seedKeyboardBatch(batch, 1);
    const EN = translator('en');
    const paths = [reviewPath('/admin/review'), reviewPath(`/admin/review/${batch}`)];
    for (const [t, headers] of [[RU, {}], [EN, { Cookie: `${LANG_COOKIE}=en` }]]) {
        for (const path of paths) {
            const { status, body } = await request('GET', path, null, headers);
            assert.equal(status, 200);
            assert.ok(body.includes(`<details class="card onboarding">\n        <summary>${t('onb_summary')}</summary>`), `${t.lang} ${path}`);
            assert.ok(!/<details[^>]*\bopen\b/.test(body), 'closed by default');
            for (const s of ['what', 'workflow', 'verdicts', 'track', 'player', 'timing', 'bounds', 'hotkeys', 'comments']) {
                assert.ok(body.includes(`<h3>${t(`onb_${s}_title`)}</h3>`), `${t.lang} section ${s}`);
            }
            // Hotkeys come from the list the key handler uses (STATE.letters on the item page).
            assert.ok(body.includes(`<td><kbd>1</kbd></td><td>${t('hotkey_verdict', { label: t.text('verdict_sponsor') })}</td>`));
            assert.ok(body.includes(`<td><kbd>5</kbd></td><td>${t('hotkey_track')}</td>`));
            assert.ok(body.includes(`<td><kbd>o</kbd></td><td>${t('hotkey_player')}</td>`));
            assert.ok(body.includes(`<td><kbd>t</kbd></td><td>${t('hotkey_bounds')}</td>`));
            assert.ok(body.includes(t('onb_bounds_html', { bounds: 't' })));
            assert.ok(body.includes(t('onb_player_html', { player: 'o', next: 'j', prev: 'k' })));
        }
    }
    const page = loadKeyboardPage((await request('GET', paths[1], null)).body, { local: memoryStorage(), session: memoryStorage() });
    assert.deepEqual({ ...page.state().letters }, { c: 'comment', j: 'next', k: 'prev', o: 'player', t: 'bounds' });
});
