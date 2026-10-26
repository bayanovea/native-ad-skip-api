'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseViewsText, MAX_VIEWS } = require('../lib/parse-views-text');

const CASES = [
    ['6,4 млн просмотров', 6400000],
    ['39,4 тыс просмотров', 39400],
    ['1 млн просмотров', 1000000],
    ['8 тыс просмотров', 8000],
    ['319 тыс просмотров', 319000],
    ['442 просмотра', 442],
    ['61 просмотр', 61],
    ['39.4K views', 39400],
    ['70.6K views', 70600],
    ['1.7M views', 1700000],
    ['319K views', 319000],
    ['1 234 567 просмотров', 1234567],
    ['1,234,567 views', 1234567],
    ['12,5 тыс. просмотров', 12500],
    ['1,234 тыс', 1234],
    ['1,2345 тыс', null],
    ['1,2', null],
    ['12,34', null],
    ['1 23 456', null],
    ['Загружается...', null],
    ['', null],
    ['2.1B views', 2100000000],
    ['3 млрд просмотров', null],
    ['1,234.567 views', null],
    ['1234,567', null],
    ['39,4 тыс просмотров', 39400],
    ['  7   ', 7],
    ['0 просмотров', 0],
    ['1.5 Kviews', null],
    ['12 345 678 912 просмотров', null],
];

for (const [text, expected] of CASES) {
    test(`parseViewsText(${JSON.stringify(text)}) → ${expected}`, () => {
        assert.equal(parseViewsText(text), expected);
    });
}

test('non-strings are null', () => {
    assert.equal(parseViewsText(undefined), null);
    assert.equal(parseViewsText(null), null);
    assert.equal(parseViewsText(['1 млн']), null);
    assert.equal(parseViewsText(42), null);
});

test('the INTEGER bound', () => {
    assert.equal(MAX_VIEWS, 2147483647);
    assert.equal(parseViewsText('2147483647'), 2147483647);
    assert.equal(parseViewsText('2147483648'), null);
});
