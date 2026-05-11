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
