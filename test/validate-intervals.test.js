'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateIntervals, MAX_INTERVALS, MAX_SECONDS } = require('../lib/validate-intervals');

function rejects(value, re, message) {
    assert.throws(() => validateIntervals(value), re, message);
}

test('accepts a single valid interval', () => {
    assert.equal(validateIntervals([{ start: 5, end: 30 }]), true);
});

test('accepts fractional seconds that stay valid after rounding', () => {
    assert.equal(validateIntervals([{ start: 5.4, end: 30.6 }]), true);
});

test('accepts the bounds 0 and MAX_SECONDS', () => {
    assert.equal(MAX_SECONDS, 86400);
    assert.equal(validateIntervals([{ start: 0, end: MAX_SECONDS }]), true);
    assert.equal(validateIntervals([{ start: -0.4, end: MAX_SECONDS + 0.4 }]), true, 'rounds to 0 and 86400');
});

test('rejects anything that is not an array', () => {
    for (const value of [undefined, null, {}, 'x', 5, { start: 0, end: 10 }]) {
        rejects(value, /data\.intervals must be an array/);
    }
});

test('rejects an empty array', () => {
    rejects([], /must not be empty/);
});

test('accepts MAX_INTERVALS items, rejects one more', () => {
    assert.equal(MAX_INTERVALS, 20);
    const items = n => Array.from({ length: n }, (_, i) => ({ start: i * 10, end: i * 10 + 5 }));
    assert.equal(validateIntervals(items(20)), true);
    rejects(items(21), /at most 20 items/);
});

test('rejects items that are not objects', () => {
    rejects([null], /data\.intervals\[0\] must be an object/);
    rejects([{ start: 0, end: 10 }, 7], /data\.intervals\[1\] must be an object/);
    rejects(['0-10'], /data\.intervals\[0\] must be an object/);
});

test('rejects a missing start or end', () => {
    rejects([{ end: 10 }], /data\.intervals\[0\]\.start must be a finite number/);
    rejects([{ start: 0 }], /data\.intervals\[0\]\.end must be a finite number/);
    rejects([{ start: 0, end: 10 }, { start: 20 }], /data\.intervals\[1\]\.end must be a finite number/);
});

test('rejects non-finite and non-numeric values', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, true, {}, [], 'abc', '10s', 'Infinity']) {
        rejects([{ start: 0, end: bad }], /\.end must be a finite number/);
        rejects([{ start: bad, end: 10 }], /\.start must be a finite number/);
    }
});

test('accepts numeric strings, rejects blank strings', () => {
    assert.equal(validateIntervals([{ start: '5', end: '30.5' }]), true);
    assert.equal(validateIntervals([{ start: ' 5 ', end: 30 }]), true);
    rejects([{ start: '', end: 10 }], /\.start must be a finite number/);
    rejects([{ start: 0, end: '   ' }], /\.end must be a finite number/);
});

test('rejects a negative start', () => {
    rejects([{ start: -1, end: 10 }], /\.start must be >= 0/);
    rejects([{ start: -0.6, end: 10 }], /\.start must be >= 0/, 'rounds to -1');
});

test('rejects an end past MAX_SECONDS', () => {
    rejects([{ start: 0, end: MAX_SECONDS + 1 }], /\.end must be <= 86400/);
    rejects([{ start: 0, end: MAX_SECONDS + 0.5 }], /\.end must be <= 86400/, 'rounds to 86401');
});

test('rejects end <= start', () => {
    rejects([{ start: 10, end: 10 }], /\.start must be less than end/);
    rejects([{ start: 10, end: 5 }], /\.start must be less than end/);
});

test('checks the rounded values, so 1.2 to 1.4 is rejected', () => {
    rejects([{ start: 1.2, end: 1.4 }], /data\.intervals\[0\]\.start must be less than end/);
    assert.equal(validateIntervals([{ start: 1.2, end: 1.5 }]), true, 'rounds to 1 and 2');
});
