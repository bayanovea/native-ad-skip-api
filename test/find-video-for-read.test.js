'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { findVideoForReadWithOutcome } = require('../lib/find-video-for-read');

// Build a stubbed `models.Video` whose `findOne` returns the first row that
// matches a recorded query (matched by deep-equal on the `where` clause).
// Each query records the call so tests can assert on side effects too.
function makeModels(rowsByQuery) {
    const updates = [];
    const findOneCalls = [];
    return {
        models: {
            Video: {
                async findOne({ where }) {
                    findOneCalls.push(where);
                    for (const entry of rowsByQuery) {
                        if (matchesWhere(entry.where, where)) {
                            if (entry.row == null) return null;
                            const row = {
                                ...entry.row,
                                async update(values) {
                                    updates.push({ rowBefore: { ...entry.row }, values });
                                    Object.assign(entry.row, values);
                                },
                            };
                            return row;
                        }
                    }
                    return null;
                },
            },
        },
        updates,
        findOneCalls,
    };
}

function matchesWhere(expected, actual) {
    if (Object.keys(expected).length !== Object.keys(actual).length) return false;
    for (const k of Object.keys(expected)) {
        if (!(k in actual)) return false;
        const ev = expected[k];
        const av = actual[k];
        if (k === 'duration' && ev && typeof ev === 'object' && ev[Op.between]) {
            if (!av || typeof av !== 'object' || !av[Op.between]) return false;
            const [el, eh] = ev[Op.between];
            const [al, ah] = av[Op.between];
            if (el !== al || eh !== ah) return false;
        } else if (ev !== av) {
            return false;
        }
    }
    return true;
}

test('match: video found by (native_id, duration ± 1)', async () => {
    const { models } = makeModels([
        { where: { native_id: 'v1', duration: { [Op.between]: [299, 301] } }, row: { id: 1, native_id: 'v1', duration: 300 } },
    ]);
    const result = await findVideoForReadWithOutcome(models, 'v1', 300);
    assert.equal(result.outcome, 'match');
    assert.equal(result.video.id, 1);
});

test('backfilled: video had null duration, helper updates it', async () => {
    const { models, updates } = makeModels([
        { where: { native_id: 'v1', duration: { [Op.between]: [299, 301] } }, row: null },
        { where: { native_id: 'v1', duration: null }, row: { id: 2, native_id: 'v1', duration: null } },
    ]);
    const result = await findVideoForReadWithOutcome(models, 'v1', 300);
    assert.equal(result.outcome, 'backfilled');
    assert.equal(result.video.id, 2);
    assert.equal(updates.length, 1, 'update called exactly once');
    assert.deepEqual(updates[0].values, { duration: 300 });
});

test('mismatch: only native_id matches, stored duration differs by > 1', async () => {
    const { models, updates } = makeModels([
        { where: { native_id: 'v1', duration: { [Op.between]: [299, 301] } }, row: null },
        { where: { native_id: 'v1', duration: null }, row: null },
        { where: { native_id: 'v1' }, row: { id: 3, native_id: 'v1', duration: 500 } },
    ]);
    const result = await findVideoForReadWithOutcome(models, 'v1', 300);
    assert.equal(result.outcome, 'mismatch');
    assert.equal(result.video.id, 3);
    assert.equal(updates.length, 0, 'no update on mismatch');
});

test('no_duration: request had no duration, video found by native_id alone', async () => {
    const { models, updates, findOneCalls } = makeModels([
        { where: { native_id: 'v1' }, row: { id: 4, native_id: 'v1', duration: 200 } },
    ]);
    const result = await findVideoForReadWithOutcome(models, 'v1', null);
    assert.equal(result.outcome, 'no_duration');
    assert.equal(result.video.id, 4);
    assert.equal(updates.length, 0, 'no update on no_duration');
    assert.equal(findOneCalls.length, 1, 'should not probe duration-range/null branches when duration is null');
});

test('not_found: no row matches at all (duration provided)', async () => {
    const { models, updates } = makeModels([
        { where: { native_id: 'v1', duration: { [Op.between]: [299, 301] } }, row: null },
        { where: { native_id: 'v1', duration: null }, row: null },
        { where: { native_id: 'v1' }, row: null },
    ]);
    const result = await findVideoForReadWithOutcome(models, 'v1', 300);
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.video, null);
    assert.equal(updates.length, 0);
});

test('not_found: no row matches at all (no duration in request)', async () => {
    const { models, updates } = makeModels([
        { where: { native_id: 'v1' }, row: null },
    ]);
    const result = await findVideoForReadWithOutcome(models, 'v1', null);
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.video, null);
    assert.equal(updates.length, 0);
});
