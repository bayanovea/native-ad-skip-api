'use strict';

// Parser for the blind review sheets written by `adskip sheet`
// (ad-skip-segment-eval/cmd/adskip/sheet.go): a `<sheet>.md` with one block per
// item and a private `<sheet>.key.tsv` with exact seconds and the runs that
// flagged each item. Only blind sheets (`C<n>` items) are supported.

const VERDICTS = ['sponsor', 'self_promotion', 'not_ad', 'unclear'];

const VERDICT_ALIASES = {
    'sponsor': 'sponsor',
    'self_promotion': 'self_promotion',
    'self promotion': 'self_promotion',
    'self-promotion': 'self_promotion',
    'not an ad': 'not_ad',
    'not an add': 'not_ad',
    'not ad': 'not_ad',
    'not_ad': 'not_ad',
    'unclear': 'unclear',
};

const HEADER_RE = /^###\s+([A-Za-z]+)(\d+)\.\s+(\S+)/;

// Canonical verdict for free text (case and whitespace ignored), or undefined.
function lookupVerdict(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ');
    return Object.prototype.hasOwnProperty.call(VERDICT_ALIASES, t) ? VERDICT_ALIASES[t] : undefined;
}

// Map the free text after `Verdict:` to a canonical verdict. Empty text means
// no verdict yet (null); anything unknown throws, naming the item.
function normalizeVerdict(text, itemCode) {
    if (String(text == null ? '' : text).trim() === '') return null;
    const v = lookupVerdict(text);
    if (!v) {
        throw new Error(`${itemCode || 'item'}: unknown verdict "${String(text).trim()}"`);
    }
    return v;
}

// Player time like `adskip sheet` prints it: seconds rounded half up (Go's
// int(sec + 0.5)), `m:ss` below an hour, `h:mm:ss` above. The key file keeps
// one decimal, so a key value ending in .5 can differ by 1 s from the md
// header (which was rounded from the unrounded time).
function formatPlayerTime(seconds) {
    const total = Math.trunc(Number(seconds) + 0.5);
    if (total < 0) return '-' + formatPlayerTime(-total);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, '0');
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${m}:${ss}`;
}

// Inverse of formatPlayerTime for what an assessor types: `s`, `m:ss` or
// `h:mm:ss` (whole seconds; two-digit minutes and seconds below 60 after the
// first part) → seconds, NaN for anything else. A number is returned as is.
// Self-contained: the review page inlines it (and validateVerdictBounds) into its script.
function parsePlayerTime(text) {
    if (typeof text === 'number') return text;
    if (typeof text !== 'string') return NaN;
    const t = text.trim();
    if (!/^\d+(:\d+){0,2}$/.test(t)) return NaN;
    const parts = t.split(':');
    if (parts.slice(1).some((p) => p.length !== 2 || Number(p) >= 60)) return NaN;
    return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

// Why `{start, end}` cannot be a verdict's bounds, or null when they can:
// `format` (not whole seconds), `range` (outside 0…86400), `order`, `short`
// (under 5 s, the shortest segment ai/pipeline/publish.go serves).
function validateVerdictBounds({ start, end }) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return 'format';
    if (start < 0 || end > 86400) return 'range';
    if (start >= end) return 'order';
    if (end - start < 5) return 'short';
    return null;
}

function parseKeyTsv(keyTsvText) {
    const rows = new Map();
    const lines = String(keyTsvText).split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length === 0) throw new Error('key.tsv is empty');
    const header = lines[0].split('\t').map((h) => h.trim());
    const col = (name) => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`key.tsv: missing column "${name}"`);
        return i;
    };
    const iItem = col('item');
    const iNative = col('native_id');
    const iStart = col('start');
    const iEnd = col('end');
    const iRuns = col('runs_flagging');
    for (const line of lines.slice(1)) {
        const f = line.split('\t');
        const bad = (why) => new Error(`key.tsv: bad row "${line}": ${why}`);
        // Every cell is required; a missing, empty or whitespace-only one is an
        // error (Number('') is 0, so blank times would otherwise pass as 0).
        const cell = (i, name) => {
            const v = (f[i] || '').trim();
            if (v === '') throw bad(`empty "${name}"`);
            return v;
        };
        // `adskip sheet` writes times as %.1f (may be negative near the start
        // of a video); hex, exponent or other Number() forms are not accepted.
        // A digit string too long for a double converts to Infinity, so the
        // converted value must be finite too.
        const seconds = (i, name) => {
            const v = cell(i, name);
            if (!/^[+-]?\d+(\.\d+)?$/.test(v)) throw bad(`"${name}" is not a number`);
            const n = Number(v);
            if (!Number.isFinite(n)) throw bad(`"${name}" is not a finite number`);
            return n;
        };
        const code = cell(iItem, 'item');
        if (!/^[A-Za-z]+\d+$/.test(code)) throw bad(`"item" is not an item code`);
        const nativeId = cell(iNative, 'native_id');
        const start = seconds(iStart, 'start');
        const end = seconds(iEnd, 'end');
        if (!(end > start)) throw bad('"end" is not after "start"');
        // Every sheet item was flagged by at least one run.
        const flaggedBy = cell(iRuns, 'runs_flagging').split(',').map((r) => r.trim()).filter(Boolean);
        if (flaggedBy.length === 0) throw bad('empty "runs_flagging"');
        if (rows.has(code)) throw new Error(`key.tsv: duplicate item "${code}"`);
        rows.set(code, { native_id: nativeId, start, end, flagged_by: flaggedBy });
    }
    return rows;
}

// Split the md into item blocks: a `### ` header line plus the lines up to the
// next markdown heading (`#`..`######` followed by a space) or a `---` rule line,
// so trailing content (a `## Notes` section, a footer) never ends up in the last
// item's comment. A comment line like `#tag` (no space) stays in the comment.
function splitBlocks(mdText) {
    const blocks = [];
    let cur = null;
    for (const line of String(mdText).split(/\r?\n/)) {
        if (/^###(\s|$)/.test(line)) {
            cur = { header: line, lines: [] };
            blocks.push(cur);
        } else if (/^#{1,6}(\s|$)/.test(line) || /^-{3,}\s*$/.test(line)) {
            cur = null;
        } else if (cur) {
            cur.lines.push(line);
        }
    }
    return blocks;
}

function parseBlock(block) {
    const m = HEADER_RE.exec(block.header);
    if (!m) throw new Error(`cannot parse item header "${block.header}"`);
    const prefix = m[1].toUpperCase();
    const itemCode = `${prefix}${m[2]}`;
    if (prefix !== 'C') {
        throw new Error(`${itemCode}: only blind sheets (C<n> items) are supported`);
    }
    const item = {
        item_code: itemCode,
        position: Number(m[2]),
        native_id: m[3],
        proposed: null,
        cues: null,
        link: null,
        verdict: null,
        comment: null,
    };
    const cues = [];
    const comment = [];
    let seenVerdict = false;
    for (const raw of block.lines) {
        const line = raw.trim();
        if (seenVerdict) {
            if (line !== '') comment.push(line);
            continue;
        }
        if (line.startsWith('Proposed as:')) {
            item.proposed = line.slice('Proposed as:'.length).split('/')
                .map((c) => c.trim()).filter(Boolean).join('+');
        } else if (line.startsWith('Link:')) {
            item.link = line.slice('Link:'.length).trim();
        } else if (line.startsWith('>')) {
            cues.push(line.replace(/^>\s?/, ''));
        } else if (line.startsWith('Verdict:')) {
            seenVerdict = true;
            item.verdict = normalizeVerdict(line.slice('Verdict:'.length), itemCode);
        }
    }
    if (!item.proposed) throw new Error(`${itemCode}: missing "Proposed as:" line`);
    // `adskip sheet` always writes the player link (already at start − 2 s);
    // the page uses it as is, so an item without one is a broken sheet.
    if (!/^https?:\/\//i.test(item.link || '')) throw new Error(`${itemCode}: missing or non-http "Link:" line`);
    if (!seenVerdict) throw new Error(`${itemCode}: missing "Verdict:" line`);
    // `adskip sheet` writes an empty `Verdict: ` line, so the verdict is often
    // typed on the next line (`Verdict: ` / `not an ad` / reason). With an empty
    // `Verdict:` the first non-empty line after it must be the verdict; text
    // there without a verdict is an error rather than a silently dropped mark.
    if (item.verdict === null && comment.length) {
        const v = lookupVerdict(comment[0]);
        if (!v) {
            throw new Error(`${itemCode}: empty "Verdict:" line and "${comment[0]}" after it is not a verdict`);
        }
        item.verdict = v;
        comment.shift();
    }
    item.cues = cues.length ? cues.join('\n') : null;
    item.comment = comment.length ? comment.join('\n') : null;
    return item;
}

// parseSheet(mdText, keyTsvText) → { items: [...] }. Times and flagged_by come
// from the key file, everything else from the md. Throws on the first problem;
// a caller must not write anything when it throws.
function parseSheet(mdText, keyTsvText) {
    const keys = parseKeyTsv(keyTsvText);
    const items = [];
    const seen = new Set();
    for (const block of splitBlocks(mdText)) {
        const item = parseBlock(block);
        if (seen.has(item.item_code)) throw new Error(`${item.item_code}: duplicate item in md`);
        seen.add(item.item_code);
        const key = keys.get(item.item_code);
        if (!key) throw new Error(`${item.item_code}: no row in key.tsv`);
        if (key.native_id !== item.native_id) {
            throw new Error(`${item.item_code}: native_id differs between md (${item.native_id}) and key.tsv (${key.native_id})`);
        }
        items.push({
            item_code: item.item_code,
            position: item.position,
            native_id: item.native_id,
            start: key.start,
            end: key.end,
            proposed: item.proposed,
            cues: item.cues,
            link: item.link,
            flagged_by: key.flagged_by,
            verdict: item.verdict,
            comment: item.comment,
        });
    }
    return { items };
}

// Cut sheet items into batches of at most `maxItems`, in position order, as
// `[{ batch, items }]`: n items → ceil(n / maxItems) parts of near-equal size
// (104 → 26 × 4, not 30/30/30/14) named `<sheet>-p<k>` from `firstPart` on. A
// whole sheet (firstPart 1) within the limit keeps the plain sheet name.
function splitSheet(sheet, items, maxItems, firstPart = 1) {
    const sorted = [...items].sort((a, b) => a.position - b.position);
    if (sorted.length === 0) return [];
    if (firstPart === 1 && sorted.length <= maxItems) return [{ batch: sheet, items: sorted }];
    const count = Math.ceil(sorted.length / maxItems);
    const base = Math.floor(sorted.length / count);
    const parts = [];
    for (let k = 0, from = 0; k < count; k++) {
        const size = base + (k < sorted.length % count ? 1 : 0);
        parts.push({ batch: `${sheet}-p${firstPart + k}`, items: sorted.slice(from, from + size) });
        from += size;
    }
    return parts;
}

module.exports = {
    VERDICTS,
    parseSheet,
    splitSheet,
    normalizeVerdict,
    formatPlayerTime,
    parsePlayerTime,
    validateVerdictBounds,
};
