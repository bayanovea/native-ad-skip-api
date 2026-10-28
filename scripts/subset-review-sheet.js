'use strict';

// Writes a blind copy of part of a review sheet: the chosen items of
// `<sheet>.md` + `<sheet>.key.tsv` go to `<out>.md` + `<out>.key.tsv` with
// every `Verdict:` emptied and the comment lines dropped, so a second reviewer
// can take the same stretches without seeing the first one's verdicts.
// Item codes, positions and the header are kept as they are.
//
// Usage: node scripts/subset-review-sheet.js <sheet.md> <out.md> C1,C4,C9
//        node scripts/subset-review-sheet.js <sheet.md> <out.md> --sample 25 [--seed 7]
// --sample picks N items at random, at most one per video, keeping the share
// of proposed categories; --seed makes the pick reproducible.

const fs = require('node:fs');
const { parseSheet, rng, shuffle } = require('../lib/review-sheet');

function usage(msg) {
    if (msg) console.error(msg);
    console.error('usage: node scripts/subset-review-sheet.js <sheet.md> <out.md> (C1,C2,… | --sample N [--seed S])');
    process.exit(2);
}

function parseArgs(argv) {
    const [mdPath, outPath, ...rest] = argv;
    if (!mdPath || !outPath) usage();
    if (!mdPath.endsWith('.md') || !outPath.endsWith('.md')) usage('sheet and out must be .md files');
    if (mdPath === outPath) usage('out must differ from the sheet');
    const opts = { mdPath, outPath, codes: null, sample: null, seed: 1 };
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--sample') opts.sample = Number(rest[++i]);
        else if (rest[i] === '--seed') opts.seed = Number(rest[++i]);
        else if (rest[i].startsWith('-')) usage(`unknown option ${rest[i]}`);
        else opts.codes = rest[i].split(',').map((c) => c.trim()).filter(Boolean);
    }
    if (!opts.codes && !(opts.sample > 0)) usage('give item codes or --sample N');
    return opts;
}

// One item per video, then N of them with the proposed-category mix of the
// whole sheet (largest remainder), random within each category.
function sample(items, n, seed) {
    const random = rng(seed);
    const perVideo = new Map();
    for (const it of shuffle(items, random)) if (!perVideo.has(it.native_id)) perVideo.set(it.native_id, it);
    const pool = [...perVideo.values()];
    if (pool.length <= n) return pool;
    const byCat = new Map();
    for (const it of pool) {
        if (!byCat.has(it.proposed)) byCat.set(it.proposed, []);
        byCat.get(it.proposed).push(it);
    }
    const share = [...byCat].map(([cat, list]) => ({ cat, list, exact: (n * list.length) / pool.length }));
    for (const s of share) s.take = Math.min(s.list.length, Math.floor(s.exact));
    let left = n - share.reduce((sum, s) => sum + s.take, 0);
    for (const s of share.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)))) {
        if (left > 0 && s.take < s.list.length) { s.take++; left--; }
    }
    return share.flatMap((s) => s.list.slice(0, s.take));
}

// The md as blocks: the header (everything before the first item) and one
// block per item, each cut after its `Verdict:` line.
function splitMd(md) {
    const lines = md.split('\n');
    const blocks = [];
    let header = [];
    let current = null;
    for (const line of lines) {
        const m = /^###\s+([A-Za-z]+\d+)\./.exec(line);
        if (m) {
            current = { code: m[1], lines: [] };
            blocks.push(current);
        }
        if (current) current.lines.push(line); else header.push(line);
    }
    return { header: header.join('\n').replace(/\s+$/, ''), blocks };
}

function blindBlock(block) {
    const out = [];
    for (const line of block.lines) {
        if (line.startsWith('Verdict:')) { out.push('Verdict: '); break; }
        out.push(line);
    }
    return out.join('\n').replace(/\s+$/, '');
}

function main() {
    const { mdPath, outPath, codes, sample: n, seed } = parseArgs(process.argv.slice(2));
    const keyPath = mdPath.replace(/\.md$/, '.key.tsv');
    const outKeyPath = outPath.replace(/\.md$/, '.key.tsv');
    const md = fs.readFileSync(mdPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const { items } = parseSheet(md, key);

    let chosen;
    if (codes) {
        const byCode = new Map(items.map((it) => [it.item_code, it]));
        const missing = codes.filter((c) => !byCode.has(c));
        if (missing.length) throw new Error(`not in the sheet: ${missing.join(', ')}`);
        chosen = codes.map((c) => byCode.get(c));
    } else {
        chosen = sample(items, n, seed);
    }
    const keep = new Set(chosen.map((it) => it.item_code));
    const ordered = items.filter((it) => keep.has(it.item_code));

    const { header, blocks } = splitMd(md);
    const byCode = new Map(blocks.map((b) => [b.code, b]));
    const body = ordered.map((it) => blindBlock(byCode.get(it.item_code))).join('\n\n');
    const keyLines = key.split(/\r?\n/).filter((l) => l.trim() !== '');
    const keyOut = [keyLines[0], ...keyLines.slice(1).filter((l) => keep.has(l.split('\t')[0]))];

    for (const f of [outPath, outKeyPath]) if (fs.existsSync(f)) throw new Error(`${f} exists; not overwriting`);
    fs.writeFileSync(outPath, `${header}\n\n${body}\n`);
    fs.writeFileSync(outKeyPath, `${keyOut.join('\n')}\n`);

    const cats = {};
    for (const it of ordered) cats[it.proposed] = (cats[it.proposed] || 0) + 1;
    console.log(`wrote ${outPath} + key: ${ordered.length} of ${items.length} items, ${new Set(ordered.map((it) => it.native_id)).size} videos`);
    console.log(`proposed: ${Object.entries(cats).map(([c, k]) => `${c} ${k}`).join(', ')}`);
    console.log(`items: ${ordered.map((it) => it.item_code).join(',')}`);
}

main();
