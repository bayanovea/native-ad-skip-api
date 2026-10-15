'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSheet, normalizeVerdict, formatPlayerTime } = require('../lib/review-sheet');

const md = fs.readFileSync(path.join(__dirname, 'fixtures/review-sheet.md'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures/review-sheet.key.tsv'), 'utf8');

const KEY_HEADER = 'item\tnative_id\tstart\tend\tcategories\truns_flagging\n';

test('parseSheet: items, times and blind fields from the fixture', () => {
    const { items } = parseSheet(md, key);
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.item_code), ['C2', 'C5', 'C7']);
    assert.deepEqual(items.map((i) => i.position), [2, 5, 7]);

    const c2 = items[0];
    assert.equal(c2.native_id, '-1_456000901');
    assert.equal(c2.start, 262.4);
    assert.equal(c2.end, 269.2);
    assert.equal(c2.proposed, 'sponsor');
    assert.equal(c2.link, 'https://example.invalid/video-1_456000901?t=4m20s');
    assert.match(c2.cues, /^юг, как же здорово/);
    assert.deepEqual(c2.flagged_by, ['2026-10-14-claude-sonnet-5-5-v2.1-batch-nt-think']);
});

test('parseSheet: verdicts and comments', () => {
    const { items } = parseSheet(md, key);
    const [c2, c5, c7] = items;
    assert.equal(c2.verdict, 'sponsor');
    assert.equal(c2.comment, null);

    // `not an add` typo normalised; multi-line comment kept, blank lines dropped.
    assert.equal(c5.verdict, 'not_ad');
    const lines = c5.comment.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Просьба покомментить есть/);
    assert.match(lines[1], /^Вторая строка комментария/);

    // Empty verdict = no verdict yet.
    assert.equal(c7.verdict, null);
    assert.equal(c7.comment, null);
});

test('parseSheet: several proposed categories and several flagging runs', () => {
    const sheet = [
        '### C1. -1_2 · 0:10 – 0:20 (10 s)', '',
        'Proposed as: self_promotion / sponsor', '',
        'Link: https://example.invalid/video-1_2?t=0m8s', '',
        '> cue', '',
        'Verdict: Self Promotion', '',
    ].join('\n');
    const k = KEY_HEADER + 'C1\t-1_2\t10.0\t20.0\tself_promotion+sponsor\trun-a,run-b\n';
    const { items } = parseSheet(sheet, k);
    assert.equal(items[0].proposed, 'self_promotion+sponsor');
    assert.deepEqual(items[0].flagged_by, ['run-a', 'run-b']);
    assert.equal(items[0].verdict, 'self_promotion');
});

test('parseSheet: unknown verdict throws and names the item', () => {
    const bad = md.replace('Verdict: sponsor', 'Verdict: maybe ad');
    assert.throws(() => parseSheet(bad, key), /C2: unknown verdict "maybe ad"/);
});

test('parseSheet: md item without a key row throws', () => {
    const k = key.split('\n').filter((l) => !l.startsWith('C5\t')).join('\n');
    assert.throws(() => parseSheet(md, k), /C5: no row in key\.tsv/);
});

test('parseSheet: native_id differs between md and key throws', () => {
    const k = key.replace('C7\t-1_456000903', 'C7\t-1_1');
    assert.throws(() => parseSheet(md, k), /C7: native_id differs/);
});

test('parseSheet: category-conflict sheets are rejected', () => {
    const sheet = '### K1. -1_2 · 0:10 – 0:20 (10 s)\n\nDetector said: sponsor · Humans labelled: self_promotion\n\nVerdict: \n';
    assert.throws(() => parseSheet(sheet, KEY_HEADER + 'K1\t-1_2\t10\t20\tsponsor\trun-a\n'), /K1: only blind sheets/);
});

test('normalizeVerdict: table from the plan', () => {
    const cases = {
        'sponsor': 'sponsor',
        '  Sponsor ': 'sponsor',
        'self_promotion': 'self_promotion',
        'self promotion': 'self_promotion',
        'Self-Promotion': 'self_promotion',
        'not an ad': 'not_ad',
        'not an add': 'not_ad',
        'NOT AD': 'not_ad',
        'not_ad': 'not_ad',
        'unclear': 'unclear',
    };
    for (const [input, want] of Object.entries(cases)) {
        assert.equal(normalizeVerdict(input, 'C1'), want, input);
    }
    assert.equal(normalizeVerdict('', 'C1'), null);
    assert.equal(normalizeVerdict('   ', 'C1'), null);
    assert.equal(normalizeVerdict(null, 'C1'), null);
    assert.throws(() => normalizeVerdict('ad', 'C9'), /C9: unknown verdict "ad"/);
});

test('formatPlayerTime: rounded like adskip sheet', () => {
    assert.equal(formatPlayerTime(0), '0:00');
    assert.equal(formatPlayerTime(59), '0:59');
    assert.equal(formatPlayerTime(919.8), '15:20');
    assert.equal(formatPlayerTime(928.9), '15:29');
    assert.equal(formatPlayerTime(59.5), '1:00');
    assert.equal(formatPlayerTime(59.4), '0:59');
    assert.equal(formatPlayerTime(1801.9), '30:02');
    assert.equal(formatPlayerTime(3843), '1:04:03');
    assert.equal(formatPlayerTime(3599.6), '1:00:00');
});

test('formatPlayerTime: matches every header of the fixture sheet', () => {
    const { items } = parseSheet(md, key);
    const headers = md.split('\n').filter((l) => l.startsWith('### '));
    items.forEach((it, i) => {
        const span = `${formatPlayerTime(it.start)} – ${formatPlayerTime(it.end)}`;
        assert.ok(headers[i].includes(span), `${headers[i]} vs ${span}`);
    });
});
