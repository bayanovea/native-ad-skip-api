'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSheet, normalizeVerdict, formatPlayerTime, parsePlayerTime, validateVerdictBounds, splitSheet, entryInsideSheetItem, cuesOver } = require('../lib/review-sheet');
const { linkAt } = require('../lib/player-link');

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
    // Object.prototype keys are not verdicts.
    assert.throws(() => normalizeVerdict('constructor', 'C9'), /C9: unknown verdict "constructor"/);
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

test('formatPlayerTime: negative seconds keep the sign', () => {
    assert.equal(formatPlayerTime(-121.5), '-2:01');   // Go's int() truncates toward zero
});

// One minimal valid block; tests below break one part at a time.
function block(code = 'C1', { proposed = 'Proposed as: sponsor', link = 'Link: https://example.invalid/video-1_2?t=8s', verdict = 'Verdict: sponsor' } = {}) {
    return [`### ${code}. -1_2 · 0:10 – 0:20 (10 s)`, '', proposed, '', link, '', '> cue', '', verdict, ''].join('\n');
}
const KEY_C1 = KEY_HEADER + 'C1\t-1_2\t10.0\t20.0\tsponsor\trun-a\n';

test('parseSheet: guards on the md side throw and name the problem', () => {
    assert.throws(() => parseSheet(block('C1', { proposed: '' }), KEY_C1), /C1: missing "Proposed as:" line/);
    assert.throws(() => parseSheet(block('C1', { verdict: '' }), KEY_C1), /C1: missing "Verdict:" line/);
    assert.throws(() => parseSheet(block('C1', { link: '' }), KEY_C1), /C1: missing or non-http "Link:" line/);
    assert.throws(() => parseSheet(block('C1', { link: 'Link: javascript:alert(1)' }), KEY_C1), /C1: missing or non-http "Link:" line/);
    assert.throws(() => parseSheet(block('C1') + block('C1'), KEY_C1), /C1: duplicate item in md/);
    assert.throws(() => parseSheet('### Notes\n\nsomething\n', KEY_C1), /cannot parse item header "### Notes"/);
});

test('parseSheet: guards on the key.tsv side throw', () => {
    assert.throws(() => parseSheet(block(), ''), /key\.tsv is empty/);
    assert.throws(() => parseSheet(block(), 'item\tnative_id\tstart\tend\tcategories\nC1\t-1_2\t10\t20\tsponsor\n'),
        /key\.tsv: missing column "runs_flagging"/);
    assert.throws(() => parseSheet(block(), KEY_HEADER + 'C1\t-1_2\tten\t20.0\tsponsor\trun-a\n'), /key\.tsv: bad row/);
});

test('parseSheet: blank, whitespace-only or malformed key.tsv cells throw instead of becoming 0 / empty', () => {
    const row = (r) => () => parseSheet(block(), KEY_HEADER + r + '\n');
    assert.throws(row('C1\t-1_2\t\t20.0\tsponsor\trun-a'), /key\.tsv: bad row ".*": empty "start"/);
    assert.throws(row('C1\t-1_2\t10.0\t\tsponsor\trun-a'), /key\.tsv: bad row ".*": empty "end"/);
    assert.throws(row('C1\t-1_2\t  \t20.0\tsponsor\trun-a'), /empty "start"/);
    assert.throws(row('C1\t-1_2\t10.0\t \tsponsor\trun-a'), /empty "end"/);
    assert.throws(row('C1\t\t10.0\t20.0\tsponsor\trun-a'), /empty "native_id"/);
    assert.throws(row(' \t-1_2\t10.0\t20.0\tsponsor\trun-a'), /empty "item"/);
    assert.throws(row('C1\t-1_2\t10.0\t20.0\tsponsor\t'), /empty "runs_flagging"/);
    assert.throws(row('C1\t-1_2\t10.0\t20.0\tsponsor\t , '), /empty "runs_flagging"/);
    // A truncated row (missing trailing cells) is the same as empty cells.
    assert.throws(row('C1\t-1_2\t10.0'), /empty "end"/);
    assert.throws(row('C1\t-1_2\t0x10\t20.0\tsponsor\trun-a'), /"start" is not a number/);
    assert.throws(row('C1\t-1_2\t10.0\t2e1\tsponsor\trun-a'), /"end" is not a number/);
    // Decimal strings too long for a double convert to +/-Infinity.
    const huge = '1' + '0'.repeat(400);
    assert.throws(row(`C1\t-1_2\t10.0\t${huge}\tsponsor\trun-a`), /"end" is not a finite number/);
    assert.throws(row(`C1\t-1_2\t-${huge}\t20.0\tsponsor\trun-a`), /"start" is not a finite number/);
    assert.throws(row('C1\t-1_2\t20.0\t10.0\tsponsor\trun-a'), /"end" is not after "start"/);
    assert.throws(row('C1\t-1_2\t10.0\t10.0\tsponsor\trun-a'), /"end" is not after "start"/);
    assert.throws(row('C-1\t-1_2\t10.0\t20.0\tsponsor\trun-a'), /"item" is not an item code/);
    assert.throws(row('C1\t-1_2\t10.0\t20.0\tsponsor\trun-a\nC1\t-1_2\t30.0\t40.0\tsponsor\trun-a'),
        /key\.tsv: duplicate item "C1"/);
});

test('parseSheet: negative key.tsv times (a stretch before 0:00) still parse', () => {
    const { items } = parseSheet(block(), KEY_HEADER + 'C1\t-1_2\t-11.0\t-1.4\tsponsor\trun-a\n');
    assert.equal(items[0].start, -11);
    assert.equal(items[0].end, -1.4);
});

test('parseSheet: CRLF files parse the same as LF', () => {
    const crlf = (t) => t.replace(/\n/g, '\r\n');
    assert.deepEqual(parseSheet(crlf(md), crlf(key)), parseSheet(md, key));
});

test('parseSheet: content after the last item (heading, rule) is not part of its comment', () => {
    const tail = '\n---\n\nfooter text\n\n## Notes\n\nsee you\n';
    assert.equal(parseSheet(block('C1', { verdict: 'Verdict: sponsor\nreal comment' }) + tail, KEY_C1).items[0].comment, 'real comment');
    const { items } = parseSheet(md + tail, key);
    assert.equal(items[2].comment, null, 'C7 has no comment');
});

test('parseSheet: verdict on the line after an empty "Verdict:" (style of earlier sheets)', () => {
    // `adskip sheet` writes `Verdict: ` with nothing after it; the assessor types
    // the verdict on the next line, then the reason.
    const nextLine = parseSheet(block('C1', { verdict: 'Verdict: \n\nNot an ad\nУпоминание вскользь.\nВторая строка.' }), KEY_C1).items[0];
    assert.equal(nextLine.verdict, 'not_ad');
    assert.equal(nextLine.comment, 'Упоминание вскользь.\nВторая строка.');

    const onlyVerdict = parseSheet(block('C1', { verdict: 'Verdict:\nself_promotion' }), KEY_C1).items[0];
    assert.equal(onlyVerdict.verdict, 'self_promotion');
    assert.equal(onlyVerdict.comment, null);

    // A verdict on the Verdict: line keeps the next lines as comment, even one
    // that looks like a verdict.
    const sameLine = parseSheet(block('C1', { verdict: 'Verdict: sponsor\nnot an ad' }), KEY_C1).items[0];
    assert.equal(sameLine.verdict, 'sponsor');
    assert.equal(sameLine.comment, 'not an ad');

    // Text after an empty Verdict: that is not a verdict fails loudly, never dropped.
    assert.throws(() => parseSheet(block('C1', { verdict: 'Verdict: \nне реклама, просто шутка' }), KEY_C1),
        /C1: empty "Verdict:" line and "не реклама, просто шутка" after it is not a verdict/);
});

test('parseSheet: only markdown headings and rule lines end an item', () => {
    const comment = '#хештег в комментарии\n#no-space heading-like line\n-- two dashes\n--- not a rule';
    const { items } = parseSheet(block('C1', { verdict: `Verdict: sponsor\n${comment}` }) + '\n# Footer\n\ntext\n', KEY_C1);
    assert.equal(items[0].comment, comment);
    // `####` is a heading, not an item header: it ends the item.
    assert.equal(parseSheet(block('C1', { verdict: 'Verdict: sponsor\nkept' }) + '#### Sub\nnot kept\n', KEY_C1).items[0].comment, 'kept');
});

test('splitSheet: balanced parts in position order, plain name within the limit, numbering from firstPart', () => {
    const items = (n) => Array.from({ length: n }, (_, i) => ({ item_code: `C${n - i}`, position: n - i }));
    const shape = (parts) => parts.map((p) => [p.batch, p.items.length]);

    const seventy = splitSheet('s', items(70), 30);
    assert.deepEqual(shape(seventy), [['s-p1', 24], ['s-p2', 23], ['s-p3', 23]]);
    assert.deepEqual(seventy.flatMap((p) => p.items.map((it) => it.position)), Array.from({ length: 70 }, (_, i) => i + 1));
    assert.deepEqual(shape(splitSheet('s', items(104), 30)), [['s-p1', 26], ['s-p2', 26], ['s-p3', 26], ['s-p4', 26]]);
    assert.deepEqual(shape(splitSheet('s', items(31), 30)), [['s-p1', 16], ['s-p2', 15]]);
    assert.deepEqual(shape(splitSheet('s', items(30), 30)), [['s', 30]]);
    assert.deepEqual(shape(splitSheet('s', items(3), 2)), [['s-p1', 2], ['s-p2', 1]]);
    assert.deepEqual(shape(splitSheet('s', items(5), 30, 4)), [['s-p4', 5]], 'a new part of an existing sheet is always numbered');
    assert.deepEqual(shape(splitSheet('s', items(40), 30, 2)), [['s-p2', 20], ['s-p3', 20]]);
    assert.deepEqual(splitSheet('s', [], 30), []);
});

test('parsePlayerTime: seconds, m:ss, h:mm:ss; the inverse of formatPlayerTime', () => {
    for (const [text, seconds] of [['0', 0], ['42', 42], [' 75 ', 75], ['1:05', 65], ['0:07', 7], ['12:00', 720], ['90:00', 5400],
        ['1:02:03', 3723], ['0:00:09', 9], ['10:59:59', 39599]]) {
        assert.equal(parsePlayerTime(text), seconds, text);
    }
    assert.equal(parsePlayerTime(17), 17);
    for (const s of [0, 5, 59, 60, 61, 599, 3599, 3600, 3661, 86400]) assert.equal(parsePlayerTime(formatPlayerTime(s)), s, String(s));
});

test('parsePlayerTime: NaN on anything else', () => {
    for (const text of ['', ' ', 'x', '1:5x', '1:60', '1:60:00', '1:00:60', '12.5', '1:05.5', '-5', '1::05', ':05', '1:', '01:008:06', '23-01']) {
        assert.ok(Number.isNaN(parsePlayerTime(text)), JSON.stringify(text));
    }
    for (const value of [null, undefined, {}, [], true]) assert.ok(Number.isNaN(parsePlayerTime(value)));
});

test('validateVerdictBounds: whole seconds, 0…86400, start before end; short bounds are valid', () => {
    assert.equal(validateVerdictBounds({ start: 0, end: 5 }), null);
    assert.equal(validateVerdictBounds({ start: 86395, end: 86400 }), null);
    assert.equal(validateVerdictBounds({ start: 10.5, end: 40 }), 'format');
    assert.equal(validateVerdictBounds({ start: 10, end: NaN }), 'format');
    assert.equal(validateVerdictBounds({ start: '10', end: 40 }), 'format');
    assert.equal(validateVerdictBounds({ start: -1, end: 40 }), 'range');
    assert.equal(validateVerdictBounds({ start: 86000, end: 86401 }), 'range');
    assert.equal(validateVerdictBounds({ start: 40, end: 40 }), 'order');
    assert.equal(validateVerdictBounds({ start: 40, end: 10 }), 'order');
    assert.equal(validateVerdictBounds({ start: 10, end: 11 }), null);
});

test('entryInsideSheetItem: the entry inside the item by less than a second at each end (0.05 s slack for the 0.1-s cue times)', () => {
    const item = { start: 299.6, end: 320.3 };
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, item), true);
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, { start: 299, end: 321 }), true, 'a whole second each side');
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, { start: 298.95, end: 320 }), false, '1.05 s');
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, { start: 300, end: 321.1 }), false, '1.1 s');
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, { start: 300.04, end: 319.96 }), true, 'just outside, within the slack');
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, { start: 300.05, end: 320 }), false, 'starts 0.05 s before the item');
    assert.equal(entryInsideSheetItem({ start: 300, end: 320 }, { start: 300, end: 319.95 }), false, 'ends 0.05 s after the item');
});

test('cuesOver: the text of the cues overlapping the bounds, one per line; null when none or no cues', () => {
    const cues = [{ start: 0, end: 5, text: 'a' }, { start: 5, end: 10, text: 'b' }, { start: 10, end: 15, text: 'c' }];
    assert.equal(cuesOver(cues, { start: 4, end: 11 }), 'a\nb\nc');
    assert.equal(cuesOver(cues, { start: 5, end: 10 }), 'b', 'touching ends do not overlap');
    assert.equal(cuesOver(cues, { start: 20, end: 30 }), null);
    assert.equal(cuesOver(undefined, { start: 0, end: 1 }), null);
});

test('linkAt: the prv player link in the Go provider\'s format, clamped at 0', () => {
    assert.equal(linkAt('-1_2', 58), 'https://example.invalid/video-1_2?t=58s');
    assert.equal(linkAt('-1_2', 1235), 'https://example.invalid/video-1_2?t=20m35s');
    assert.equal(linkAt('-1_2', 3661.9), 'https://example.invalid/video-1_2?t=1h1m1s');
    assert.equal(linkAt('-1_2', -2), 'https://example.invalid/video-1_2?t=0s');
});
