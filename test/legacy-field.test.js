'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { legacyField } = require('../lib/legacy-field');

function run(mw, req) {
    let called = false;
    mw(req, {}, () => { called = true; });
    assert.ok(called, 'next() called');
    return req;
}

test('legacyField: copies <legacy>_user_id to prv_user_id in the body, the query and every event of an array', () => {
    const mw = legacyField('old');
    const req = run(mw, {
        query: { old_user_id: '7', v: '1' },
        body: [{ type: 'time_saved', old_user_id: 5 }, { type: 'interval_undo', old_user_id: null }, 'junk'],
    });
    assert.deepEqual(req.query, { old_user_id: '7', v: '1', prv_user_id: '7' });
    assert.deepEqual(req.body[0], { type: 'time_saved', old_user_id: 5, prv_user_id: 5 });
    assert.deepEqual(req.body[1], { type: 'interval_undo', old_user_id: null, prv_user_id: null });
    assert.equal(req.body[2], 'junk');
    assert.deepEqual(run(mw, { query: {}, body: { old_user_id: 3 } }).body, { old_user_id: 3, prv_user_id: 3 });
});

test('legacyField: a present prv_user_id wins; no legacy field, no body or a non-object body change nothing', () => {
    const mw = legacyField('old');
    assert.deepEqual(run(mw, { query: {}, body: { old_user_id: 3, prv_user_id: 9 } }).body, { old_user_id: 3, prv_user_id: 9 });
    assert.deepEqual(run(mw, { query: {}, body: { old_user_id: 3, prv_user_id: null } }).body, { old_user_id: 3, prv_user_id: null });
    assert.deepEqual(run(mw, { query: { v: '1' }, body: { user_id: 'u' } }).body, { user_id: 'u' });
    assert.deepEqual(run(mw, { query: {}, body: undefined }).body, undefined);
    assert.equal(run(mw, { query: {}, body: 'text' }).body, 'text');
});

test('legacyField: without LEGACY_PRV the middleware only calls next()', () => {
    const req = run(legacyField(null), { query: { old_user_id: '7' }, body: { old_user_id: 7 } });
    assert.deepEqual(req.query, { old_user_id: '7' });
    assert.deepEqual(req.body, { old_user_id: 7 });
});
