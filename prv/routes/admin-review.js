const express = require('express');
const handler = require('../../middleware/handler');
const { VERDICTS, formatPlayerTime, playerLink } = require('../../lib/review-sheet');

// Assessor review page (prv only). Sibling of admin-moderation.js: same
// `?verifyBearerToken=` query auth, server-rendered HTML + AJAX decide,
// `?format=json` for tests. All reads/writes go through prv/repository/review.js,
// which also enforces the blind rule (no `flagged_by` on undecided items).

const VERDICT_LABELS = {
    sponsor: 'sponsor',
    self_promotion: 'self_promotion',
    not_ad: 'not_ad',
    unclear: 'unclear',
};
const CATEGORY_COLORS = { intro: '#6366f1', sponsor: '#f59e0b', self_promotion: '#ec4899', credits: '#10b981' };

function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// See admin-moderation.js: URL-encode before embedding into an href.
function urlToken(value) {
    if (value == null) return '';
    return encodeURIComponent(String(value));
}

// JSON for an inline <script>: escape everything that could close the script
// element or start an HTML comment, plus the JS line separators.
function scriptJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function formatDate(value) {
    if (value == null) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

// Only http(s) links are rendered as hrefs; anything else falls back to the
// computed player link.
function safeLink(link) {
    return typeof link === 'string' && /^https?:\/\//i.test(link.trim()) ? link.trim() : null;
}

function badge(category) {
    const color = CATEGORY_COLORS[category] || '#64748b';
    return `<span class="badge" style="background:${color}">${escapeHtml(category || '?')}</span>`;
}

// Same check as admin-moderation.js, plus: an unset AUTH_TOKEN never matches
// (otherwise a missing query param would equal a missing env var).
function authorized(req, res) {
    const expected = process.env.AUTH_TOKEN;
    if (!expected || req.query.verifyBearerToken !== expected) {
        res.status(401).send('Unauthorized');
        return false;
    }
    return true;
}

// Item as the page shows it: repository fields plus player times and the
// player link. The stored link (from `adskip sheet`) already sits at
// start − 2 s; it is used as is, never offset again.
function presentItem(item) {
    return {
        ...item,
        start_player: formatPlayerTime(item.start),
        end_player: formatPlayerTime(item.end),
        duration_s: Math.round(item.end - item.start),
        player_link: safeLink(item.link) || playerLink(item.native_id, item.start),
    };
}

function navRef(item) {
    return item ? { item_code: item.item_code, decided: item.verdict != null } : null;
}

const STYLE = `
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; max-width: 1100px; }
        h1 { font-size: 1.3rem; font-weight: 600; margin-bottom: 4px; }
        h2 { font-size: 1rem; font-weight: 600; margin: 22px 0 10px; color: #cbd5f5; }
        a { color: #93c5fd; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .muted { color: #64748b; font-size: 0.8rem; }
        .toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 16px; font-size: 0.9rem; }
        .toolbar .spacer { flex: 1; }
        .nav-btn { background: #1e293b; border: 1px solid #334155; color: #cbd5f5; padding: 3px 10px; border-radius: 4px; font-size: 0.8rem; }
        .nav-btn.disabled { opacity: 0.4; pointer-events: none; }
        .card { background: #1e293b; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
        .item-head { font-size: 1.05rem; font-weight: 600; margin-bottom: 6px; }
        .item-head code { font-size: 0.95rem; }
        blockquote { border-left: 3px solid #334155; padding: 6px 12px; margin: 10px 0 0; color: #cbd5e1; white-space: pre-wrap; font-size: 0.9rem; }
        code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8rem; background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #93c5fd; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
        thead tr { background: #0f172a; }
        th { text-align: left; padding: 7px 12px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 600; }
        td { padding: 7px 12px; font-size: 0.85rem; vertical-align: middle; border-top: 1px solid #0f172a; }
        td.num { font-variant-numeric: tabular-nums; }
        .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.72rem; font-weight: 600; color: #fff; }
        .badge-banned { background: #7f1d1d; color: #fecaca; margin-left: 6px; }
        .verdicts { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0 12px; }
        .verdict-btn { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 6px 14px; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
        .verdict-btn kbd { color: #64748b; margin-right: 6px; font-family: inherit; }
        .verdict-btn.selected { background: #1d4ed8; border-color: #3b82f6; }
        .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
        textarea, input[type=text] { background: #0f172a; border: 1px solid #334155; color: #e2e8f0; border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 0.9rem; }
        textarea { flex: 1; min-width: 260px; min-height: 56px; resize: vertical; }
        label { font-size: 0.8rem; color: #94a3b8; display: block; margin-bottom: 4px; }
        .save-btn { background: #14532d; border: none; color: #bbf7d0; padding: 8px 18px; border-radius: 6px; font-size: 0.95rem; cursor: pointer; margin-top: 12px; }
        .save-btn:disabled { opacity: 0.5; cursor: default; }
        .status { margin-top: 10px; font-size: 0.85rem; min-height: 1.2em; }
        .status.error { color: #fca5a5; }
        .status.ok { color: #86efac; }
        .current { font-size: 0.95rem; margin-bottom: 8px; }
        .hotkeys { margin-top: 18px; }
        .empty { color: #64748b; font-size: 0.85rem; }
        .signals-line { font-size: 0.85rem; margin-bottom: 8px; }
`;

function page(title, body) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderBatchList(batches, token) {
    const t = escapeHtml(urlToken(token));
    const rows = batches.map(b => `
            <tr>
                <td><a href="/admin/review/${escapeHtml(encodeURIComponent(b.batch))}?verifyBearerToken=${t}">${escapeHtml(b.batch)}</a></td>
                <td class="num">${b.total}</td>
                <td class="num">${b.decided}</td>
                <td class="num">${b.open}</td>
            </tr>`).join('');
    return page('Review', `
    <h1>Review</h1>
    <div class="toolbar"><a href="/admin/review?format=json&amp;verifyBearerToken=${t}">JSON</a></div>
    ${batches.length > 0 ? `
    <table>
        <thead><tr><th>Batch</th><th>Items</th><th>Decided</th><th>Open</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>` : '<div class="card empty">No review batches imported yet (scripts/import-review-sheet.js).</div>'}`);
}

function renderSignals(signals, token) {
    const t = escapeHtml(urlToken(token));
    const windowText = `${formatPlayerTime(signals.window.start)} – ${formatPlayerTime(signals.window.end)}`;
    const videoLinks = signals.videos.map(v =>
        `<a href="/admin/video/${v.id}?verifyBearerToken=${t}" target="_blank" rel="noopener">video #${v.id}${v.duration != null ? ` (${escapeHtml(v.duration)} s)` : ''} ↗</a>`
    ).join(' · ');

    const markupRows = signals.markups.map(m => {
        const author = m.user_id != null
            ? `<a href="/admin/user/${Number(m.user_id)}?verifyBearerToken=${t}" target="_blank" rel="noopener">user #${Number(m.user_id)}</a>`
            : '<span class="muted">—</span>';
        return `
            <tr>
                <td>${badge(m.category)}</td>
                <td class="num">${formatPlayerTime(m.start)} – ${formatPlayerTime(m.end)}</td>
                <td>${author}${m.author_banned ? '<span class="badge badge-banned">banned</span>' : ''}</td>
                <td class="num">${m.author_rating != null ? escapeHtml(m.author_rating) : '—'}</td>
                <td class="num muted">${Number(m.markup_id)}</td>
            </tr>`;
    }).join('');

    const segmentRows = signals.segments.map(s => `
            <tr>
                <td>${badge(s.category)}</td>
                <td class="num">${formatPlayerTime(s.start)} – ${formatPlayerTime(s.end)}</td>
                <td class="num">${escapeHtml(s.rating)}</td>
                <td class="num">${Number(s.likes)} / ${Number(s.dislikes)}</td>
                <td class="num muted">video #${Number(s.video_id)}</td>
            </tr>`).join('');

    return `
    <h2>Signals <span class="muted">(±30 s: ${windowText})</span></h2>
    <div class="signals-line">
        Undos: <strong>${Number(signals.undos)}</strong> · Clicks: <strong>${Number(signals.clicks)}</strong>
        ${signals.videos.length > 0 ? ` · ${videoLinks}` : ' · <span class="muted">no video rows for this native_id</span>'}
    </div>
    ${signals.markups.length > 0 ? `
    <table>
        <thead><tr><th>Markup</th><th>Interval</th><th>Author</th><th>Author rating</th><th>Id</th></tr></thead>
        <tbody>${markupRows}</tbody>
    </table>` : '<div class="empty">No live markups in the window.</div>'}
    ${signals.segments.length > 0 ? `
    <table>
        <thead><tr><th>Segment</th><th>Interval</th><th>Rating</th><th>Likes / dislikes</th><th>Video</th></tr></thead>
        <tbody>${segmentRows}</tbody>
    </table>` : '<div class="empty">No calculated segments in the window.</div>'}`;
}

function renderItemPage(payload, token) {
    const { batch, item, nav, signals } = payload;
    const t = escapeHtml(urlToken(token));
    const itemHref = (code) =>
        `/admin/review/${escapeHtml(encodeURIComponent(batch.batch))}?item=${escapeHtml(encodeURIComponent(code))}&amp;verifyBearerToken=${t}`;
    const navLink = (ref, label) => ref
        ? `<a class="nav-btn" href="${itemHref(ref.item_code)}">${label}</a>`
        : `<span class="nav-btn disabled">${label}</span>`;

    const proposed = String(item.proposed || '').split('+').filter(Boolean).map(badge).join(' ');
    const current = item.verdict;

    const decidedBlock = current ? `
    <div class="card">
        <div class="current">Current verdict: ${badge(current.verdict)}
            <span class="muted">by ${escapeHtml(current.reviewer)} (${escapeHtml(current.source)}), ${formatDate(current.decided_at)}</span></div>
        ${current.comment ? `<blockquote>${escapeHtml(current.comment)}</blockquote>` : ''}
        <div class="current flagged-by" style="margin-top:10px">Flagged by: ${(item.flagged_by || []).map(r => `<code>${escapeHtml(r)}</code>`).join(' ') || '<span class="muted">—</span>'}</div>
        <table>
            <thead><tr><th>When</th><th>Verdict</th><th>Reviewer</th><th>Source</th><th>Comment</th></tr></thead>
            <tbody>${item.history.map(h => `
                <tr>
                    <td class="muted">${formatDate(h.decided_at)}</td>
                    <td>${badge(h.verdict)}</td>
                    <td>${escapeHtml(h.reviewer)}</td>
                    <td class="muted">${escapeHtml(h.source)}</td>
                    <td style="white-space:pre-wrap">${escapeHtml(h.comment || '')}</td>
                </tr>`).join('')}</tbody>
        </table>
    </div>` : '';

    const verdictButtons = VERDICTS.map((v, i) => `
            <button type="button" class="verdict-btn${current && current.verdict === v ? ' selected' : ''}" data-verdict="${v}" onclick="pick('${v}')"><kbd>${i + 1}</kbd>${VERDICT_LABELS[v]}</button>`).join('');

    // Client state: only what the script needs. Never includes flagged_by.
    const state = {
        token,
        batch: batch.batch,
        item_id: item.id,
        item_code: item.item_code,
        prev: nav.prev ? nav.prev.item_code : null,
        next: nav.next ? nav.next.item_code : null,
        player_link: item.player_link,
        verdict: current ? current.verdict : null,
        verdicts: VERDICTS,
    };

    return page(`${item.item_code} · ${batch.batch}`, `
    <div class="toolbar">
        <a href="/admin/review?verifyBearerToken=${t}">All batches</a>
        <strong>${escapeHtml(batch.batch)}</strong>
        <span>${batch.decided} / ${batch.total} decided · ${batch.open} open</span>
        <span class="spacer"></span>
        ${navLink(nav.prev, `◀ ${nav.prev ? escapeHtml(nav.prev.item_code) : ''}`)}
        <strong>${escapeHtml(item.item_code)}</strong>
        ${navLink(nav.next, `${nav.next ? escapeHtml(nav.next.item_code) : ''} ▶`)}
        ${navLink(nav.first_open, 'first open')}
        <a href="${itemHref(item.item_code)}&amp;format=json">JSON</a>
    </div>

    <div class="card">
        <div class="item-head">${escapeHtml(item.item_code)} · <code>${escapeHtml(item.native_id)}</code> · ${item.start_player} – ${item.end_player} (${item.duration_s} s)
            <span class="muted" style="margin-left:10px">Proposed as:</span> ${proposed}</div>
        <a id="player-link" href="${escapeHtml(item.player_link)}" target="_blank" rel="noopener noreferrer">Open in player ↗</a>
        <span class="muted">(starts 2 s before the stretch)</span>
        ${item.cues ? `<blockquote>${escapeHtml(item.cues)}</blockquote>` : ''}
    </div>

    ${decidedBlock}

    <div class="card">
        <label>Verdict</label>
        <div class="verdicts">${verdictButtons}
        </div>
        <div class="row">
            <div style="flex:1">
                <label for="comment">Comment</label>
                <textarea id="comment" style="width:100%">${escapeHtml(current && current.comment ? current.comment : '')}</textarea>
            </div>
            <div>
                <label for="reviewer">Reviewer</label>
                <input type="text" id="reviewer" maxlength="64" placeholder="your name">
            </div>
        </div>
        <button type="button" class="save-btn" id="save-btn" onclick="save()">Save ⏎</button>
        <div class="status" id="status"></div>
    </div>

    ${renderSignals(signals, token)}

    <div class="muted hotkeys">Hotkeys: 1–4 verdict · c comment · Enter save (Ctrl/Cmd+Enter in the comment box) · Esc leave a text box · j / k next / previous · o open player</div>

<script>
    const STATE = ${scriptJson(state)};
    const REVIEWER_KEY = 'adminReview.reviewer';
    const FLASH_KEY = 'adminReview.flash';
    let picked = STATE.verdict;
    let saving = false;

    function storageGet(store, key) {
        try { return window[store].getItem(key); } catch (e) { return null; }
    }
    function storageSet(store, key, value) {
        try {
            if (value == null) window[store].removeItem(key); else window[store].setItem(key, value);
        } catch (e) { /* storage unavailable: per-viewer convenience only */ }
    }
    function itemUrl(code) {
        return '/admin/review/' + encodeURIComponent(STATE.batch) + '?item=' + encodeURIComponent(code)
            + '&verifyBearerToken=' + encodeURIComponent(STATE.token);
    }
    function setStatus(text, kind) {
        const el = document.getElementById('status');
        el.textContent = text;
        el.className = 'status' + (kind ? ' ' + kind : '');
    }
    function pick(v) {
        picked = v;
        document.querySelectorAll('.verdict-btn').forEach(function (b) {
            b.classList.toggle('selected', b.dataset.verdict === v);
        });
        setStatus('');
    }
    async function save() {
        if (saving) return;
        if (!picked) { setStatus('Pick a verdict first (1–4).', 'error'); return; }
        const reviewerEl = document.getElementById('reviewer');
        const reviewer = reviewerEl.value.trim();
        if (!reviewer) { setStatus('Enter your name in Reviewer.', 'error'); reviewerEl.focus(); return; }
        storageSet('localStorage', REVIEWER_KEY, reviewer);
        saving = true;
        const btn = document.getElementById('save-btn');
        btn.disabled = true;
        try {
            const res = await fetch('/admin/review/decide?verifyBearerToken=' + encodeURIComponent(STATE.token), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    item_id: STATE.item_id,
                    verdict: picked,
                    comment: document.getElementById('comment').value,
                    reviewer: reviewer,
                }),
            });
            if (res.status === 201) {
                const data = await res.json();
                const flagged = (data.flagged_by || []).join(', ') || '—';
                storageSet('sessionStorage', FLASH_KEY, 'Saved ' + STATE.item_code + ': ' + picked + '. Flagged by: ' + flagged);
                window.location.href = itemUrl(data.next_item || STATE.item_code);
                return;
            }
            setStatus('Error ' + res.status + ': ' + (await res.text()), 'error');
        } catch (err) {
            setStatus('Error: ' + err.message, 'error');
        }
        saving = false;
        btn.disabled = false;
    }
    document.addEventListener('keydown', function (e) {
        const el = e.target;
        const typing = el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); return; }
        if (el && el.tagName === 'A') return;
        if (typing) {
            if (e.key === 'Escape') el.blur();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const n = Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= STATE.verdicts.length) { e.preventDefault(); pick(STATE.verdicts[n - 1]); return; }
        switch (e.key) {
            case 'Enter': e.preventDefault(); save(); break;
            case 'c': e.preventDefault(); document.getElementById('comment').focus(); break;
            case 'j': if (STATE.next) window.location.href = itemUrl(STATE.next); break;
            case 'k': if (STATE.prev) window.location.href = itemUrl(STATE.prev); break;
            case 'o': window.open(STATE.player_link, '_blank', 'noopener'); break;
        }
    });
    (function init() {
        document.getElementById('reviewer').value = storageGet('localStorage', REVIEWER_KEY) || '';
        const flash = storageGet('sessionStorage', FLASH_KEY);
        if (flash) { setStatus(flash, 'ok'); storageSet('sessionStorage', FLASH_KEY, null); }
    })();
</script>`);
}

module.exports = function createAdminReviewRoutes(models, { reviewRepository }) {
    const router = express.Router();

    // GET /admin/review — batch list with progress.
    router.get('/admin/review', handler(async (req, res) => {
        if (!authorized(req, res)) return;
        const batches = await reviewRepository.listBatches();
        if (req.query.format === 'json') {
            res.json({ batches });
            return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(renderBatchList(batches, req.query.verifyBearerToken));
    }));

    // POST /admin/review/decide — append a verdict from the page. Validation
    // lives in reviewRepository.recordVerdict (ReviewInputError → 400).
    router.post('/admin/review/decide', handler(async (req, res) => {
        if (!authorized(req, res)) return;
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).send('request body must be a JSON object');
            return;
        }
        const item_id = typeof body.item_id === 'string' && /^\d+$/.test(body.item_id)
            ? Number(body.item_id)
            : body.item_id;
        try {
            await reviewRepository.recordVerdict({
                item_id,
                verdict: body.verdict,
                comment: body.comment,
                reviewer: body.reviewer,
                source: 'page',
            });
        } catch (err) {
            if (err instanceof reviewRepository.ReviewInputError) {
                res.status(400).send(err.message);
                return;
            }
            throw err;
        }
        const item = await reviewRepository.getItemById(item_id);
        const next = await reviewRepository.nextOpenItem(item.batch, item.position);
        res.status(201).json({
            item_id: item.id,
            item_code: item.item_code,
            verdict: item.verdict.verdict,
            flagged_by: item.flagged_by || [],
            next_item: next ? next.item_code : null,
        });
    }));

    // GET /admin/review/:batch?item=C7 — item page; without `item` the first
    // open item (or the last one when the batch is done).
    router.get('/admin/review/:batch', handler(async (req, res) => {
        if (!authorized(req, res)) return;
        const batchName = req.params.batch;
        const progress = await reviewRepository.getBatchProgress(batchName);
        if (!progress) { res.status(404).send('Batch not found'); return; }

        const code = typeof req.query.item === 'string' ? req.query.item.trim() : '';
        const raw = code
            ? await reviewRepository.getItem(batchName, code)
            : await reviewRepository.defaultItem(batchName);
        if (!raw) { res.status(404).send('Item not found'); return; }

        const item = presentItem(raw);
        const [{ prev, next }, firstOpen, signals] = await Promise.all([
            reviewRepository.neighbours(batchName, item.position),
            reviewRepository.firstOpenItem(batchName),
            reviewRepository.getSignals(item.native_id, item.start, item.end),
        ]);
        const payload = {
            batch: progress,
            item,
            nav: { prev: navRef(prev), next: navRef(next), first_open: navRef(firstOpen) },
            signals,
        };

        if (req.query.format === 'json') {
            res.json(payload);
            return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.send(renderItemPage(payload, req.query.verifyBearerToken));
    }));

    return router;
};
