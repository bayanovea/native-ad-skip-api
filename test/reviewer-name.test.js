'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { REVIEWER_MAX, validReviewerName } = require('../lib/reviewer-name');

test('letters of any script, digits, space, dot, underscore and dash pass as typed', () => {
    for (const name of ['gkshi', 'Анна Петрова', 'anna.p_2-x', 'Zoë', '李雷', '7']) {
        assert.equal(validReviewerName(name), name);
    }
});

test('the name is trimmed, inner spaces collapsed and NFC-normalized', () => {
    assert.equal(validReviewerName('  Анна   Петрова \n'), 'Анна Петрова');
    assert.equal(validReviewerName('Сергей'), 'Сергей');
});

test('empty, too long, other characters or not a string → null', () => {
    for (const bad of ['', '   ', 'a/b', 'a&b', '<b>', 'a\tb', 'a\nb', 'ann@x', 'a+b', 'a%20b', '①', 'x'.repeat(REVIEWER_MAX + 1), null, undefined, 42, ['a']]) {
        assert.equal(validReviewerName(bad), null, JSON.stringify(bad));
    }
    assert.equal(validReviewerName('x'.repeat(REVIEWER_MAX)), 'x'.repeat(REVIEWER_MAX));
});
