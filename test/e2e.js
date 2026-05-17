'use strict';

// Run: docker-compose -f docker-compose.e2e.yml up --build --abort-on-container-exit

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execSync, spawn } = require('node:child_process');
const { Client } = require('pg');

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

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                hostname: 'localhost',
                port: E2E_PORT,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(data && { 'Content-Length': Buffer.byteLength(data) }),
                },
            },
            res => {
                let buf = '';
                res.on('data', c => (buf += c));
                res.on('end', () => {
                    let body = null;
                    try { body = JSON.parse(buf); } catch (_) { body = buf; }
                    resolve({ status: res.statusCode, body });
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

// ── Video lookup tests (no orphan Video rows) ─────────────────────────────────

// GET must not create a Video row when the video doesn't exist
test('prv GET /video-calculated: unknown video returns 204 and creates no Video row', async () => {
    const vid = '__e2e__prv_no_orphan';
    const res = await getCalculated('', vid, { v: '1' });
    assert.equal(res.status, 204);
    assert.equal(await countVideos('', vid), 0, 'no Video row should be created');
});

// Rule 1: find by native_id + duration within ±1
test('prv GET /video-calculated: finds video by duration within ±1', async () => {
    const vid = '__e2e__prv_duration_range';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');
    const res = await getCalculated('', vid, { v: '1', duration: 301 });
    assert.equal(res.status, 200, 'should find video with duration 300 when requesting 301');
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

test('prv lookup metric: match outcome increments on duration ±1 hit', async () => {
    const vid = '__e2e__prv_metric_match';
    const cat = cats.prv.intro;
    await postMarkup('', { video_id: vid, v: '1', user_id: 'u1', category_id: cat, duration: 300, data: { intervals: [{ start: 0, end: 10 }, { start: 1, end: 11 }] } });
    runCalc('prv');

    const before = await getLookupCount('match', 'prv');
    const res = await getCalculated('', vid, { v: '1', duration: 301 });
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

test('metrics: DELETE /markups/:id normalizes to a stable label', async () => {
    await request('DELETE', '/markups/111', null);
    await request('DELETE', '/markups/222', null);
    const text = await fetchMetrics();
    assert.ok(httpDurationHasPath(text, '/markups/#id'),
        'expected normalized path /markups/#id in metrics');
    assert.ok(!httpDurationHasPath(text, '/markups/111'),
        'raw path /markups/111 leaked into metrics (normalization failed)');
});

// ── /admin/moderation page tests ──────────────────────────────────────────────

const MOD_AUTH = process.env.AUTH_TOKEN || 'test_token';

async function getModerationJson(query = '') {
    const path = `/admin/moderation?format=json&verifyBearerToken=${encodeURIComponent(MOD_AUTH)}${query}`;
    return request('GET', path, null);
}

async function seedDislikeAgainst(prefix, videoNativeId, catId, start, end, authorUserId, voterId) {
    // POST a markup authored by `authorUserId`, run calc, then POST a -1 vote by `voterId`.
    const base = { video_id: videoNativeId, v: '1', user_id: authorUserId, category_id: catId, data: {} };
    await postMarkup(prefix || '', { ...base, data: { intervals: [{ start, end }] } });
    runCalc(prefix || 'prv');
    await postVote(prefix || '', { video_id: videoNativeId, user_id: voterId, category_id: catId, start, end, vote: -1 });
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
    await seedDislikeAgainst('', vid, cat, 0, 10, 'mod-author-a', 'mod-voter-1');
    await seedDislikeAgainst('', vid, cat, 30, 40, 'mod-author-a', 'mod-voter-2');
    await seedDislikeAgainst('', vid, cat, 60, 70, 'mod-author-a', 'mod-voter-3');
    // Author B: 1 dislike
    await seedDislikeAgainst('', vid + '_b', cat, 0, 10, 'mod-author-b', 'mod-voter-4');

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
    await seedDislikeAgainst('', vid, cat, 0, 10, 'mod-markup-author', 'mod-markup-voter');

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
    await seedDislikeAgainst('', vid, cat, 0, 10, 'mod-hide-author', 'mod-hide-voter');

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
    await seedDislikeAgainst('', vid, cats.prv.intro, 0, 10, 'mod-decide-401-author', 'mod-decide-401-voter');
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
    await seedDislikeAgainst('', vid, cats.prv.intro, 0, 10, 'mod-ureject-author', 'mod-ureject-voter');
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
    await seedDislikeAgainst('', vid, cats.prv.intro, 0, 10, 'mod-uapprove-author', 'mod-uapprove-voter');
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
    await seedDislikeAgainst('', vid, cat, 0,  10, author, 'mod-resurface-v1');
    await seedDislikeAgainst('', vid, cat, 30, 40, author, 'mod-resurface-v2');
    await seedDislikeAgainst('', vid, cat, 60, 70, author, 'mod-resurface-v3');

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
    await seedDislikeAgainst('', vid + '_b', cat, 0, 10, author, 'mod-resurface-v4');
    const afterOneMore = await getModerationJson();
    assert.equal(afterOneMore.status, 200);
    const hidden2 = afterOneMore.body.users.find(u => u.user_id === authorInternalId);
    assert.equal(hidden2, undefined,
        `user must remain hidden after 1 new dislike (delta=3 < 5): ${JSON.stringify(hidden2)}`);

    // +1 more dislike → current score 15, delta = 6 ≥ 5 → re-surfaces.
    await seedDislikeAgainst('', vid + '_c', cat, 0, 10, author, 'mod-resurface-v5');
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
    await seedDislikeAgainst('', vid, cat, 0,  10, author, 'mod-showall-v1');
    await seedDislikeAgainst('', vid, cat, 30, 40, author, 'mod-showall-v2');
    await seedDislikeAgainst('', vid, cat, 60, 70, author, 'mod-showall-v3');

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
    await seedDislikeAgainst('', vid, cat, 0, 10, author, 'autoban-basic-voter-seed');

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
    await seedDislikeAgainst('', vid, cat, 0, 10, author, 'autoban-idem-voter-seed');

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
    await seedDislikeAgainst('', vid, cat, 0, 10, author, 'autoban-manual-voter-seed');

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
    await seedDislikeAgainst('', vid, cat, 0,  10, author, 'mod-zero-v1');
    await seedDislikeAgainst('', vid, cat, 30, 40, author, 'mod-zero-v2');

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
