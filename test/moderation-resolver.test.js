'use strict';

/*
 * Unit/integration tests for prv/repository/moderation.js → closestMarkupForTarget.
 *
 * The resolver is a tight SQL query that joins four tables (prv_calculated_segments,
 * prv_calculated_segment_markups, markups, markup_time_intervals), so we exercise it
 * against a real Postgres database. The harness mirrors test/e2e.js: drop+create a
 * dedicated DB (`${DB_NAME}_unit_moderation`), let Sequelize.sync() build the schema,
 * seed minimal fixtures via raw SQL, run assertions, then drop the DB on teardown.
 *
 * Run inside the docker-compose.e2e.yml container (same `make test-e2e` Docker stack
 * sets DB_HOST / DB_USER / DB_PASSWORD / DB_NAME). Standalone invocation:
 *   DB_HOST=… DB_USER=… DB_PASSWORD=… DB_NAME=… node --test test/moderation-resolver.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '5432');
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const BASE_DB = process.env.DB_NAME;
const TEST_DB = `${BASE_DB}_unit_moderation`;

let sequelize;
let moderationRepo;

function adminClient(dbName = 'postgres') {
    return new Client({ host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: dbName });
}

before(async () => {
    // 1. (Re)create the dedicated unit DB.
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.query(`CREATE DATABASE "${TEST_DB}"`);
    await c.end();

    // 2. Point Sequelize at the new DB. We can't reuse the shared `db.js` because it
    //    reads DB_NAME once at import time and also calls `sync().then(...)` async,
    //    which would race our seeds. Instead we instantiate a fresh sequelize for
    //    just the prv models.
    process.env.DB_NAME = TEST_DB;

    const { Sequelize } = require('sequelize');
    sequelize = new Sequelize(TEST_DB, DB_USER, DB_PASSWORD, {
        host: DB_HOST,
        port: DB_PORT,
        dialect: 'postgres',
        logging: false,
    });
    const prvModels = require('../prv/db')(sequelize);
    await sequelize.sync();

    moderationRepo = require('../prv/repository/moderation')(prvModels, sequelize);

    // Stash for seeding helpers.
    moderationRepo._models = prvModels;
});

after(async () => {
    if (sequelize) await sequelize.close();
    const c = adminClient();
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    await c.end();
});

// ── Seeding helpers ──────────────────────────────────────────────────────────

/**
 * Seed: 1 video + 1 calculated segment + N markups (each with 1 time interval) + the
 * junction rows linking the segment to all markups. Returns the segment + markup ids.
 *
 * @param {{
 *   categoryId: number,
 *   segStart: number,
 *   segEnd: number,
 *   markups: Array<{ start: number, end: number, deleted?: boolean }>,
 * }} fixture
 */
async function seed(fixture) {
    const { Video, CalculatedSegment, CalculatedSegmentMarkup, Markup, MarkupTimeInterval } = moderationRepo._models;
    const video = await Video.create({ native_id: `seed-${Math.random()}` });
    const segment = await CalculatedSegment.create({
        video_id: video.id, category_id: fixture.categoryId,
        start: fixture.segStart, end: fixture.segEnd, rating: 0,
    });

    const markupIds = [];
    for (const m of fixture.markups) {
        const markup = await Markup.create({
            video_id: video.id, user_id: 'seed-user', category_id: fixture.categoryId,
            is_new: false,
            deleted_at: m.deleted ? new Date() : null,
        });
        await MarkupTimeInterval.create({
            markup_id: markup.id, start: m.start, end: m.end,
            deleted_at: m.deleted ? new Date() : null,
        });
        await CalculatedSegmentMarkup.create({ segment_id: segment.id, markup_id: markup.id });
        markupIds.push(markup.id);
    }
    return { video, segment, markupIds };
}

async function ensureCategory() {
    const { MarkupCategory } = moderationRepo._models;
    const existing = await MarkupCategory.findOne();
    if (existing) return existing.id;
    const created = await MarkupCategory.create({ category: 'intro' });
    return created.id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('closestMarkupForTarget: picks the markup with smallest |Δstart|+|Δend|', async () => {
    const categoryId = await ensureCategory();
    const { segment, markupIds } = await seed({
        categoryId,
        segStart: 10, segEnd: 20,
        markups: [
            // markupIds[0]: distance to target (10,20) = |8-10|+|18-20| = 4
            { start: 8,  end: 18 },
            // markupIds[1]: distance = |10-10|+|21-20| = 1   ← winner
            { start: 10, end: 21 },
            // markupIds[2]: distance = |12-10|+|22-20| = 4
            { start: 12, end: 22 },
        ],
    });

    const row = await moderationRepo.closestMarkupForTarget({
        video_id: segment.video_id, category_id: categoryId,
        start: 10, end: 20, tolerance: 0,
    });

    assert.ok(row, 'expected a row');
    assert.equal(row.id, markupIds[1], 'closest markup should win');
    assert.equal(Number(row.distance), 1);
});

test('closestMarkupForTarget: returns null when every candidate is soft-deleted', async () => {
    const categoryId = await ensureCategory();
    const { segment } = await seed({
        categoryId,
        segStart: 30, segEnd: 40,
        markups: [
            { start: 30, end: 40, deleted: true },
            { start: 31, end: 41, deleted: true },
        ],
    });

    const row = await moderationRepo.closestMarkupForTarget({
        video_id: segment.video_id, category_id: categoryId,
        start: 30, end: 40, tolerance: 0,
    });

    assert.equal(row, null);
});

test('closestMarkupForTarget: tie on distance → smaller markup.id wins', async () => {
    const categoryId = await ensureCategory();
    const { segment, markupIds } = await seed({
        categoryId,
        segStart: 50, segEnd: 60,
        markups: [
            // both have distance 2 → first inserted (smaller id) wins
            { start: 51, end: 61 },
            { start: 49, end: 59 },
        ],
    });

    const row = await moderationRepo.closestMarkupForTarget({
        video_id: segment.video_id, category_id: categoryId,
        start: 50, end: 60, tolerance: 0,
    });

    assert.ok(row, 'expected a row');
    assert.equal(row.id, markupIds[0], 'tie should be broken by smaller markup.id');
});

test('closestMarkupForTarget: tolerance excludes segments whose start/end fall outside ±tolerance', async () => {
    const categoryId = await ensureCategory();
    const { segment, markupIds } = await seed({
        categoryId,
        segStart: 100, segEnd: 110,
        markups: [{ start: 100, end: 110 }],
    });

    // Target way off — segment is at (100,110), target at (200,210) → ΔsegStart=100, ΔsegEnd=100.
    // With tolerance=0 the candidate set is empty.
    const noMatch = await moderationRepo.closestMarkupForTarget({
        video_id: segment.video_id, category_id: categoryId,
        start: 200, end: 210, tolerance: 0,
    });
    assert.equal(noMatch, null);

    // With a generous tolerance (200) the segment is in range, and the only candidate wins.
    const match = await moderationRepo.closestMarkupForTarget({
        video_id: segment.video_id, category_id: categoryId,
        start: 200, end: 210, tolerance: 200,
    });
    assert.ok(match, 'expected a row when tolerance is large enough');
    assert.equal(match.id, markupIds[0]);
});

test('closestMarkupForTarget: ignores segments from a different video or category', async () => {
    const categoryId = await ensureCategory();
    // Seed video A.
    const a = await seed({
        categoryId,
        segStart: 0, segEnd: 5,
        markups: [{ start: 0, end: 5 }],
    });
    // Seed video B with an identical segment shape.
    const b = await seed({
        categoryId,
        segStart: 0, segEnd: 5,
        markups: [{ start: 0, end: 5 }],
    });

    const rowA = await moderationRepo.closestMarkupForTarget({
        video_id: a.segment.video_id, category_id: categoryId,
        start: 0, end: 5, tolerance: 0,
    });
    assert.equal(rowA.id, a.markupIds[0]);

    const rowB = await moderationRepo.closestMarkupForTarget({
        video_id: b.segment.video_id, category_id: categoryId,
        start: 0, end: 5, tolerance: 0,
    });
    assert.equal(rowB.id, b.markupIds[0]);
});

// ── Scoreboard tests ──────────────────────────────────────────────────────────

/**
 * Seed: 1 user + 1 video + 1 segment + 1 markup authored by that user, linked via the
 * junction table. Returns the user/video/segment/markup. Used as a building block by
 * the scoreboard tests below (each then sprinkles in votes / undos / rating tweaks).
 */
async function seedUserWithMarkup({ categoryId, prvUserId, segStart, segEnd, rating = 0, segmentRating = 0 }) {
    const { User, Video, CalculatedSegment, CalculatedSegmentMarkup, Markup, MarkupTimeInterval } = moderationRepo._models;
    const user = await User.create({
        generated_user_id: `00000000-0000-0000-0000-${String(prvUserId).padStart(12, '0')}`,
        prv_user_id: prvUserId,
        rating,
    });
    const video = await Video.create({ native_id: `vid-${prvUserId}-${Math.random()}` });
    const segment = await CalculatedSegment.create({
        video_id: video.id, category_id: categoryId,
        start: segStart, end: segEnd, rating: segmentRating,
    });
    const markup = await Markup.create({
        video_id: video.id, user_id: 'seeded', prv_user_id: prvUserId,
        category_id: categoryId, is_new: false, internal_user_id: user.id,
    });
    await MarkupTimeInterval.create({ markup_id: markup.id, start: segStart, end: segEnd });
    await CalculatedSegmentMarkup.create({ segment_id: segment.id, markup_id: markup.id });
    return { user, video, segment, markup };
}

async function seedVote({ video_id, category_id, start, end, voteValue = -1, prvUserId = 9999 }) {
    const { Vote } = moderationRepo._models;
    return Vote.create({
        user_id: '00000000-0000-0000-0000-000000000000',
        prv_user_id: prvUserId,
        video_id, category_id, start, end, vote: voteValue,
    });
}

async function seedUndo({ video_native_id, category_id, start, end, prvUserId = 8888 }) {
    const { IntervalUndo } = moderationRepo._models;
    return IntervalUndo.create({
        user_id: '00000000-0000-0000-0000-000000000000',
        prv_user_id: prvUserId,
        video_native_id, category_id, start, end,
    });
}

/**
 * Backdate a row's createdAt via raw SQL — Sequelize sets createdAt on insert, so this is
 * the only way to simulate "this signal happened > recentDays ago" in tests.
 */
async function backdate(tableName, id, daysAgo) {
    await sequelize.query(
        `UPDATE "${tableName}" SET "createdAt" = NOW() - (:days || ' days')::interval WHERE id = :id`,
        { replacements: { days: String(daysAgo), id } },
    );
}

test('getUserScoreboard: orders users by 3*dislikes + 1*undos formula', async () => {
    const categoryId = await ensureCategory();

    // User A: 2 dislikes, 1 undo → score = 3*2 + 1 = 7
    const a = await seedUserWithMarkup({ categoryId, prvUserId: 1001, segStart: 200, segEnd: 210 });
    await seedVote({ video_id: a.video.id, category_id: categoryId, start: 200, end: 210 });
    await seedVote({ video_id: a.video.id, category_id: categoryId, start: 200, end: 210 });
    await seedUndo({ video_native_id: a.video.native_id, category_id: categoryId, start: 200, end: 210 });

    // User B: 1 dislike, 3 undos → score = 3*1 + 3 = 6
    const b = await seedUserWithMarkup({ categoryId, prvUserId: 1002, segStart: 300, segEnd: 310 });
    await seedVote({ video_id: b.video.id, category_id: categoryId, start: 300, end: 310 });
    await seedUndo({ video_native_id: b.video.native_id, category_id: categoryId, start: 300, end: 310 });
    await seedUndo({ video_native_id: b.video.native_id, category_id: categoryId, start: 300, end: 310 });
    await seedUndo({ video_native_id: b.video.native_id, category_id: categoryId, start: 300, end: 310 });

    const rows = await moderationRepo.getUserScoreboard({ limit: 50, recentDays: 7 });
    const byId = new Map(rows.map(r => [r.user_id, r]));

    const rowA = byId.get(a.user.id);
    const rowB = byId.get(b.user.id);
    assert.ok(rowA, 'user A should appear');
    assert.ok(rowB, 'user B should appear');
    assert.equal(rowA.dislikes, 2);
    assert.equal(rowA.undos, 1);
    assert.equal(rowA.score, 7);
    assert.equal(rowB.dislikes, 1);
    assert.equal(rowB.undos, 3);
    assert.equal(rowB.score, 6);

    // A must precede B in the ordered output.
    const idxA = rows.findIndex(r => r.user_id === a.user.id);
    const idxB = rows.findIndex(r => r.user_id === b.user.id);
    assert.ok(idxA < idxB, `A (idx=${idxA}) should come before B (idx=${idxB})`);
});

test('getMarkupScoreboard: negative segment_rating contributes 3× to score', async () => {
    const categoryId = await ensureCategory();
    // Seed a markup whose segment has rating = -2, no votes/undos.
    const m = await seedUserWithMarkup({
        categoryId, prvUserId: 2001,
        segStart: 400, segEnd: 410,
        segmentRating: -2,
    });

    const rows = await moderationRepo.getMarkupScoreboard({ limit: 50, recentDays: 7 });
    const row = rows.find(r => r.markup_id === m.markup.id);
    assert.ok(row, 'markup should surface on scoreboard via segment_rating alone');
    assert.equal(row.dislikes, 0);
    assert.equal(row.undos, 0);
    assert.equal(row.segment_rating, -2);
    // score = 3*0 + 1*0 + 3*max(0, -(-2)) = 6
    assert.equal(row.score, 6);
    assert.equal(row.user_id, m.user.id);
    assert.equal(row.prv_user_id, 2001);
    assert.equal(row.video_id, m.video.id);
    assert.equal(row.video_native_id, m.video.native_id);
});

// ── Decision recording / latest-decision map tests ───────────────────────────

test('recordDecision + getLatestDecisionsMap: captured snapshot survives newer signals (frozen at decision time)', async () => {
    const categoryId = await ensureCategory();
    const u = await seedUserWithMarkup({ categoryId, prvUserId: 4001, segStart: 600, segEnd: 610 });

    // 2 dislikes at decision time → snapshot.score = 6.
    await seedVote({ video_id: u.video.id, category_id: categoryId, start: 600, end: 610 });
    await seedVote({ video_id: u.video.id, category_id: categoryId, start: 600, end: 610 });

    const inserted = await moderationRepo.recordDecision({
        target_type: 'user',
        target_id: u.user.id,
        decision: 'approve',
        decided_by: 'admin',
    });
    assert.ok(inserted && inserted.id, 'recordDecision should return a row with an id');
    assert.equal(inserted.signals_snapshot.dislikes, 2);
    assert.equal(inserted.signals_snapshot.score, 6);

    // New dislike AFTER the decision should NOT alter the stored snapshot.
    await seedVote({ video_id: u.video.id, category_id: categoryId, start: 600, end: 610 });

    const map = await moderationRepo.getLatestDecisionsMap('user', [u.user.id]);
    const latest = map.get(u.user.id);
    assert.ok(latest, 'expected a decision in the map');
    assert.equal(latest.signals_snapshot.dislikes, 2, 'snapshot is frozen at decision time, not live');
    assert.equal(latest.signals_snapshot.score, 6);
});

test('getLatestDecisionsMap: targets with no prior decision are absent from the map', async () => {
    const categoryId = await ensureCategory();
    const u = await seedUserWithMarkup({ categoryId, prvUserId: 4002, segStart: 700, segEnd: 710 });

    const map = await moderationRepo.getLatestDecisionsMap('user', [u.user.id]);
    assert.equal(map.has(u.user.id), false, 'undecided target must not appear in the map');
    assert.equal(map.get(u.user.id), undefined);
});

test('getLatestDecisionsMap: empty target_ids → empty Map', async () => {
    const map = await moderationRepo.getLatestDecisionsMap('user', []);
    assert.ok(map instanceof Map);
    assert.equal(map.size, 0);
});

test('recordDecision twice on same target: both rows persist, latest wins in the map', async () => {
    const categoryId = await ensureCategory();
    const u = await seedUserWithMarkup({ categoryId, prvUserId: 4003, segStart: 800, segEnd: 810 });

    // First decision: snapshot at 0 signals → score 0.
    const first = await moderationRepo.recordDecision({
        target_type: 'user',
        target_id: u.user.id,
        decision: 'approve',
        decided_by: 'admin',
    });

    // Accumulate signals, then second decision: snapshot should now reflect 1 dislike → score 3.
    await seedVote({ video_id: u.video.id, category_id: categoryId, start: 800, end: 810 });
    const second = await moderationRepo.recordDecision({
        target_type: 'user',
        target_id: u.user.id,
        decision: 'reject',
        decided_by: 'admin',
    });

    assert.notEqual(first.id, second.id, 'both inserts should produce distinct rows');

    // Both rows must persist in the table.
    const allRows = await sequelize.query(
        'SELECT id, decision, signals_snapshot FROM prv_admin_decisions WHERE target_type = :tt AND target_id = :tid ORDER BY id ASC',
        { replacements: { tt: 'user', tid: u.user.id }, type: require('sequelize').QueryTypes.SELECT },
    );
    assert.equal(allRows.length, 2, 'both decision rows should be persisted');
    assert.equal(allRows[0].decision, 'approve');
    assert.equal(allRows[1].decision, 'reject');

    // Map returns only the most recent (the reject row).
    const map = await moderationRepo.getLatestDecisionsMap('user', [u.user.id]);
    const latest = map.get(u.user.id);
    assert.ok(latest, 'latest decision should be in the map');
    assert.equal(latest.id, second.id);
    assert.equal(latest.decision, 'reject');
    assert.equal(latest.signals_snapshot.dislikes, 1);
});

test('recordDecision: rejects invalid target_type / decision / decided_by', async () => {
    await assert.rejects(
        () => moderationRepo.recordDecision({ target_type: 'bogus', target_id: 1, decision: 'approve', decided_by: 'admin' }),
        /invalid target_type/,
    );
    await assert.rejects(
        () => moderationRepo.recordDecision({ target_type: 'user', target_id: 1, decision: 'maybe', decided_by: 'admin' }),
        /invalid decision/,
    );
    await assert.rejects(
        () => moderationRepo.recordDecision({ target_type: 'user', target_id: 1, decision: 'approve', decided_by: 'someone' }),
        /invalid decided_by/,
    );
});

test('recordDecision (markup target): snapshot includes segment_rating and matches formula', async () => {
    const categoryId = await ensureCategory();
    // Seed a markup whose segment has rating = -3.
    const m = await seedUserWithMarkup({
        categoryId, prvUserId: 4010,
        segStart: 900, segEnd: 910,
        segmentRating: -3,
    });

    const row = await moderationRepo.recordDecision({
        target_type: 'markup',
        target_id: m.markup.id,
        decision: 'reject',
        decided_by: 'admin',
    });

    assert.equal(row.target_type, 'markup');
    assert.equal(row.target_id, m.markup.id);
    assert.equal(row.signals_snapshot.segment_rating, -3);
    // score = 3*0 + 1*0 + 3*max(0, -(-3)) = 9
    assert.equal(row.signals_snapshot.score, 9);
});

test('getUserScoreboard: signals older than recentDays are excluded from *_7d but counted in all-time totals', async () => {
    const categoryId = await ensureCategory();
    const u = await seedUserWithMarkup({ categoryId, prvUserId: 3001, segStart: 500, segEnd: 510 });

    // One recent vote, one backdated 30d.
    const v1 = await seedVote({ video_id: u.video.id, category_id: categoryId, start: 500, end: 510 });
    const v2 = await seedVote({ video_id: u.video.id, category_id: categoryId, start: 500, end: 510 });
    await backdate('votes', v2.id, 30);

    // One recent undo, one backdated 30d.
    const un1 = await seedUndo({ video_native_id: u.video.native_id, category_id: categoryId, start: 500, end: 510 });
    const un2 = await seedUndo({ video_native_id: u.video.native_id, category_id: categoryId, start: 500, end: 510 });
    await backdate('prv_events_interval_undo', un2.id, 30);

    const rows = await moderationRepo.getUserScoreboard({ limit: 50, recentDays: 7 });
    const row = rows.find(r => r.user_id === u.user.id);
    assert.ok(row, 'user should appear');
    assert.equal(row.dislikes, 2, 'all-time dislikes count both votes');
    assert.equal(row.dislikes_7d, 1, '*_7d excludes the backdated vote');
    assert.equal(row.undos, 2, 'all-time undos count both undos');
    assert.equal(row.undos_7d, 1, '*_7d excludes the backdated undo');
    // score uses the all-time counts (formula isn't time-windowed)
    assert.equal(row.score, 3 * 2 + 1 * 2);
    // Unused var hints — keep linters quiet without disabling rules
    void v1; void un1;
});

test('getMarkupScoreboard: orders markups by score DESC across mixed signal mixes', async () => {
    const categoryId = await ensureCategory();
    // Markup A: 0 dislikes, 0 undos, segment_rating -2 → score = 6
    const a = await seedUserWithMarkup({ categoryId, prvUserId: 5101, segStart: 1000, segEnd: 1010, segmentRating: -2 });
    // Markup B: 3 dislikes, 0 undos, segment_rating 0 → score = 9
    const b = await seedUserWithMarkup({ categoryId, prvUserId: 5102, segStart: 1100, segEnd: 1110, segmentRating: 0 });
    await seedVote({ video_id: b.video.id, category_id: categoryId, start: 1100, end: 1110 });
    await seedVote({ video_id: b.video.id, category_id: categoryId, start: 1100, end: 1110 });
    await seedVote({ video_id: b.video.id, category_id: categoryId, start: 1100, end: 1110 });
    // Markup C: 1 dislike, 2 undos, segment_rating -1 → score = 3 + 2 + 3 = 8
    const c = await seedUserWithMarkup({ categoryId, prvUserId: 5103, segStart: 1200, segEnd: 1210, segmentRating: -1 });
    await seedVote({ video_id: c.video.id, category_id: categoryId, start: 1200, end: 1210 });
    await seedUndo({ video_native_id: c.video.native_id, category_id: categoryId, start: 1200, end: 1210 });
    await seedUndo({ video_native_id: c.video.native_id, category_id: categoryId, start: 1200, end: 1210 });

    const rows = await moderationRepo.getMarkupScoreboard({ limit: 50, recentDays: 7 });
    const ids = rows.map(r => r.markup_id);

    const idxA = ids.indexOf(a.markup.id);
    const idxB = ids.indexOf(b.markup.id);
    const idxC = ids.indexOf(c.markup.id);
    assert.ok(idxA >= 0 && idxB >= 0 && idxC >= 0, `all 3 must surface: ${JSON.stringify(rows)}`);
    // Expected order: B (9) > C (8) > A (6)
    assert.ok(idxB < idxC, `B (score=9, idx=${idxB}) must precede C (score=8, idx=${idxC})`);
    assert.ok(idxC < idxA, `C (score=8, idx=${idxC}) must precede A (score=6, idx=${idxA})`);

    const rowA = rows[idxA];
    const rowB = rows[idxB];
    const rowC = rows[idxC];
    assert.equal(rowA.score, 6);
    assert.equal(rowB.score, 9);
    assert.equal(rowC.score, 8);
});

test('getLatestDecisionsMap: works for markup target type', async () => {
    const categoryId = await ensureCategory();
    const m = await seedUserWithMarkup({ categoryId, prvUserId: 5201, segStart: 1300, segEnd: 1310 });

    const inserted = await moderationRepo.recordDecision({
        target_type: 'markup',
        target_id: m.markup.id,
        decision: 'approve',
        decided_by: 'admin',
    });

    const map = await moderationRepo.getLatestDecisionsMap('markup', [m.markup.id]);
    const latest = map.get(m.markup.id);
    assert.ok(latest, 'markup decision should be present in the map');
    assert.equal(latest.id, inserted.id);
    assert.equal(latest.target_type, 'markup');
    assert.equal(latest.target_id, m.markup.id);
    assert.equal(latest.decision, 'approve');
});

test('closestMarkupForTarget: ignores segments from a different category in the same video', async () => {
    // Seed two distinct categories so we can have segments under each. The shared
    // helper uses one category; this test creates a second to verify isolation.
    const cat1 = await ensureCategory();
    const { MarkupCategory } = moderationRepo._models;
    let cat2;
    const existingCat2 = await MarkupCategory.findOne({ where: { category: 'sponsor' } });
    if (existingCat2) {
        cat2 = existingCat2.id;
    } else {
        const created = await MarkupCategory.create({ category: 'sponsor' });
        cat2 = created.id;
    }
    assert.notEqual(cat1, cat2, 'two distinct category IDs required');

    // Single video, two segments at identical (start, end) but different categories.
    const { Video, CalculatedSegment, CalculatedSegmentMarkup, Markup, MarkupTimeInterval } = moderationRepo._models;
    const video = await Video.create({ native_id: `xcat-${Math.random()}` });

    // Segment + markup under cat1.
    const seg1 = await CalculatedSegment.create({ video_id: video.id, category_id: cat1, start: 0, end: 5, rating: 0 });
    const m1 = await Markup.create({ video_id: video.id, user_id: 'seed-user', category_id: cat1, is_new: false });
    await MarkupTimeInterval.create({ markup_id: m1.id, start: 0, end: 5 });
    await CalculatedSegmentMarkup.create({ segment_id: seg1.id, markup_id: m1.id });

    // Segment + markup under cat2 — should NOT be returned when we query cat1.
    const seg2 = await CalculatedSegment.create({ video_id: video.id, category_id: cat2, start: 0, end: 5, rating: 0 });
    const m2 = await Markup.create({ video_id: video.id, user_id: 'seed-user', category_id: cat2, is_new: false });
    await MarkupTimeInterval.create({ markup_id: m2.id, start: 0, end: 5 });
    await CalculatedSegmentMarkup.create({ segment_id: seg2.id, markup_id: m2.id });

    const rowCat1 = await moderationRepo.closestMarkupForTarget({
        video_id: video.id, category_id: cat1,
        start: 0, end: 5, tolerance: 0,
    });
    assert.ok(rowCat1, 'expected a row under cat1');
    assert.equal(rowCat1.id, m1.id, 'cat1 query must return the cat1 markup');

    const rowCat2 = await moderationRepo.closestMarkupForTarget({
        video_id: video.id, category_id: cat2,
        start: 0, end: 5, tolerance: 0,
    });
    assert.ok(rowCat2, 'expected a row under cat2');
    assert.equal(rowCat2.id, m2.id, 'cat2 query must return the cat2 markup');
});

test('recordDecision: rejects zero / negative target_id', async () => {
    await assert.rejects(
        () => moderationRepo.recordDecision({ target_type: 'user', target_id: 0, decision: 'approve', decided_by: 'admin' }),
        /positive integer/,
    );
    await assert.rejects(
        () => moderationRepo.recordDecision({ target_type: 'user', target_id: -1, decision: 'approve', decided_by: 'admin' }),
        /positive integer/,
    );
});
