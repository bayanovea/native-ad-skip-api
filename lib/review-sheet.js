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

// Map the free text after `Verdict:` to a canonical verdict. Empty text means
// no verdict yet (null); anything unknown throws, naming the item.
function normalizeVerdict(text, itemCode) {
    const t = String(text == null ? '' : text).trim().toLowerCase().replace(/\s+/g, ' ');
    if (t === '') return null;
    const v = VERDICT_ALIASES[t];
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

// prv player link like `adskip sheet` writes it (provider prv LinkAt): the
// stretch start truncated to whole seconds minus 2 s, clamped at 0, as
// `?t=1h2m3s` / `?t=2m3s` / `?t=7s`. The stored `link` of an imported item
// already carries this offset; this is the fallback when an item has none.
function playerLink(nativeId, start) {
    let sec = Math.trunc(Number(start)) - 2;
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    let t = `${m}m${s}s`;
    if (h > 0) t = `${h}h${t}`;
    else if (m === 0) t = `${s}s`;
    return `https://example.invalid/video${nativeId}?t=${t}`;
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
        const code = (f[iItem] || '').trim();
        const start = Number(f[iStart]);
        const end = Number(f[iEnd]);
        if (!code || !Number.isFinite(start) || !Number.isFinite(end)) {
            throw new Error(`key.tsv: bad row "${line}"`);
        }
        rows.set(code, {
            native_id: (f[iNative] || '').trim(),
            start,
            end,
            flagged_by: (f[iRuns] || '').split(',').map((r) => r.trim()).filter(Boolean),
        });
    }
    return rows;
}

// Split the md into item blocks: header line plus the lines up to the next `###`.
function splitBlocks(mdText) {
    const blocks = [];
    let cur = null;
    for (const line of String(mdText).split(/\r?\n/)) {
        if (line.startsWith('###')) {
            cur = { header: line, lines: [] };
            blocks.push(cur);
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
    if (!seenVerdict) throw new Error(`${itemCode}: missing "Verdict:" line`);
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

module.exports = {
    VERDICTS,
    parseSheet,
    normalizeVerdict,
    formatPlayerTime,
    playerLink,
};
