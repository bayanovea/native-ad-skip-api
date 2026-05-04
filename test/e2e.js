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

async function getCalculated(prefix, videoId, extra = {}) {
    const params = new URLSearchParams({ video_id: videoId, ...extra });
    const path = prefix ? `/${prefix}/video-calculated?${params}` : `/video-calculated?${params}`;
    const res = await request('GET', path, null);
    return res; // { status, body: segment[] | null }
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
