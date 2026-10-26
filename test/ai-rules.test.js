'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { parseMinSegmentSeconds } = require('../lib/ai-rules');

test('parseMinSegmentSeconds: unset or empty is 5, a positive integer is taken', () => {
    assert.equal(parseMinSegmentSeconds(undefined), 5);
    assert.equal(parseMinSegmentSeconds(''), 5);
    assert.equal(parseMinSegmentSeconds('3'), 3);
    assert.equal(parseMinSegmentSeconds('12'), 12);
});

test('parseMinSegmentSeconds: anything else throws', () => {
    for (const bad of ['0', '-1', '2.5', 'five', ' 5']) {
        assert.throws(() => parseMinSegmentSeconds(bad), /AI_MIN_SEGMENT_SECONDS/, bad);
    }
});

test('MIN_SEGMENT_SECONDS is read once on require; an invalid value throws there', () => {
    const load = value => spawnSync(process.execPath,
        ['-e', `process.stdout.write(String(require(${JSON.stringify(path.join(__dirname, '../lib/ai-rules'))}).MIN_SEGMENT_SECONDS))`],
        { env: { ...process.env, AI_MIN_SEGMENT_SECONDS: value }, encoding: 'utf8' });
    assert.equal(load('7').stdout, '7');
    assert.equal(load('').stdout, '5');
    const r = load('0');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /AI_MIN_SEGMENT_SECONDS must be an integer of at least 1/);
});
