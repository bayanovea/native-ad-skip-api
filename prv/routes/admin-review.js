const express = require('express');
const handler = require('../../middleware/handler');
const { VERDICTS, formatPlayerTime } = require('../../lib/review-sheet');
const { ReviewInputError, SIGNALS_WINDOW, REVIEWER_MAX } = require('../repository/review');
const { CATEGORY_COLORS, escapeHtml, urlToken, formatDate } = require('../../lib/admin-html');

// Assessor review page (prv only). Sibling of admin-moderation.js: same
// `?verifyBearerToken=` query auth, server-rendered HTML + AJAX decide,
// `?format=json` for tests. All reads/writes go through prv/repository/review.js,
// which also enforces the blind rule (no `flagged_by` on undecided items).

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

// Only http(s) links are rendered as hrefs (the importer requires one; this
// guards rows written by other means).
function safeLink(link) {
    return typeof link === 'string' && /^https?:\/\//i.test(link.trim()) ? link.trim() : null;
}

// "Wrong text" is a page-only shortcut, not a stored verdict: it saves
// `unclear` with this comment (the cue text does not match what the video says).
const WRONG_TEXT = 'wrong_text';
const WRONG_TEXT_COMMENT = 'Текст в видео не совпадает с текстом из субтитров.';
// Verdict buttons in hotkey order (1–5).
const CHOICES = [...VERDICTS, WRONG_TEXT];
const CHOICE_LABELS = { [WRONG_TEXT]: 'Wrong text' };

// Inline SVG icons (stroke = currentColor, Lucide-style 24×24 paths).
function icon(paths, cls = 'icon') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
const CHOICE_ICONS = {
    sponsor: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    self_promotion: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    not_ad: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    unclear: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    [WRONG_TEXT]: '<path d="M3 6h14"/><path d="M3 12h9"/><path d="M3 18h7"/><path d="m15 14 6 6"/><path d="m21 14-6 6"/>',
};
const QUOTE_ICON = '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>';

// The button a stored verdict lights up: `unclear` saved through "Wrong text"
// keeps showing as Wrong text.
function choiceOf(verdict) {
    if (!verdict) return null;
    if (verdict.verdict === 'unclear' && (verdict.comment || '').startsWith(WRONG_TEXT_COMMENT)) return WRONG_TEXT;
    return verdict.verdict;
}

// Nav reference as the page shows it: the raw link becomes `player_link`
// (null when not http(s)), so switching items can open the player.
function presentNav(ref) {
    return ref ? { item_code: ref.item_code, decided: ref.decided, player_link: safeLink(ref.link) } : null;
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
// start − 2 s; it is used as is, never offset again. Null when not http(s).
function presentItem(item) {
    return {
        ...item,
        start_player: formatPlayerTime(item.start),
        end_player: formatPlayerTime(item.end),
        duration_s: Math.round(item.end - item.start),
        player_link: safeLink(item.link),
    };
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
        .item-id { margin-top: 12px; font-size: 0.7rem; }
        .cues { display: flex; gap: 12px; align-items: flex-start; margin-top: 14px; padding: 12px 14px; background: #0f172a; border-radius: 8px; }
        .cues .quote-icon { flex: none; width: 22px; height: 22px; color: #475569; margin-top: 3px; }
        .cues-text { white-space: pre-wrap; font-size: 1.2rem; line-height: 1.5; color: #f1f5f9; }
        .proposed { font-size: 0.9rem; margin-bottom: 12px; }
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
        .verdict-btn { display: inline-flex; align-items: center; gap: 8px; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 6px 12px 6px 8px; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
        .verdict-btn .icon { width: 16px; height: 16px; color: #94a3b8; }
        .verdict-btn.selected { background: #1d4ed8; border-color: #3b82f6; }
        .verdict-btn.selected .icon { color: #fff; }
        kbd { display: inline-block; min-width: 1.6em; padding: 1px 5px; border: 1px solid #475569; border-bottom-width: 3px; border-radius: 4px; background: #1e293b; color: #cbd5e1; font: 600 0.75rem/1.3 'JetBrains Mono', 'Fira Code', monospace; text-align: center; }
        .verdict-btn.selected kbd { background: #1e40af; border-color: #93c5fd; color: #fff; }
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
    <meta name="referrer" content="no-referrer">
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
    <h2>Signals <span class="muted">(±${SIGNALS_WINDOW} s: ${windowText})</span></h2>
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
        ? `<a class="nav-btn" href="${itemHref(ref.item_code)}" data-item-code="${escapeHtml(ref.item_code)}"${ref.player_link ? ` data-player-link="${escapeHtml(ref.player_link)}"` : ''}>${label}</a>`
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

    const currentChoice = choiceOf(current);
    const verdictButtons = CHOICES.map((v, i) => `
            <button type="button" class="verdict-btn${currentChoice === v ? ' selected' : ''}" data-verdict="${v}" onclick="pick('${v}')"><kbd>${i + 1}</kbd>${icon(CHOICE_ICONS[v])}${CHOICE_LABELS[v] || v}</button>`).join('');

    // Client state: only what the script needs. Never includes flagged_by.
    const state = {
        token,
        batch: batch.batch,
        item_id: item.id,
        item_code: item.item_code,
        prev: nav.prev ? nav.prev.item_code : null,
        next: nav.next ? nav.next.item_code : null,
        prev_player_link: nav.prev ? nav.prev.player_link : null,
        next_player_link: nav.next ? nav.next.player_link : null,
        player_link: item.player_link,
        verdict: current ? current.verdict : null,
        choice: currentChoice,
        comment: current && current.comment ? current.comment : '',
        reviewer: current ? current.reviewer : null,
        choices: CHOICES,
        wrong_text_comment: WRONG_TEXT_COMMENT,
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
        <div class="item-head">${item.start_player} – ${item.end_player} (${item.duration_s} s)</div>
        ${item.player_link
        ? `<a id="player-link" href="${escapeHtml(item.player_link)}" target="_blank" rel="noopener noreferrer">Open in player ↗</a>
        <span class="muted">(starts 2 s before the stretch)</span>`
        : '<span class="muted">No player link for this item.</span>'}
        ${item.cues ? `<div class="cues">${icon(QUOTE_ICON, 'quote-icon')}<div class="cues-text">${escapeHtml(item.cues)}</div></div>` : ''}
        <div class="muted item-id">${escapeHtml(item.item_code)} · ${escapeHtml(item.native_id)}</div>
    </div>

    ${decidedBlock}

    <div class="card">
        <div class="proposed"><span class="muted">Proposed as:</span> ${proposed}</div>
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
                <input type="text" id="reviewer" maxlength="${REVIEWER_MAX}" placeholder="your name">
            </div>
        </div>
        <button type="button" class="save-btn" id="save-btn" onclick="save()">Save ⏎</button>
        <div class="status" id="status"></div>
    </div>

    ${renderSignals(signals, token)}

    <div class="muted hotkeys">Hotkeys: <kbd>1</kbd>–<kbd>${CHOICES.length}</kbd> verdict · <kbd>c</kbd> comment · <kbd>Enter</kbd> save (<kbd>Ctrl/Cmd+Enter</kbd> in the comment box) · <kbd>Esc</kbd> leave a text box · <kbd>j</kbd> / <kbd>k</kbd> next / previous · <kbd>o</kbd> open player</div>

<script>
    const STATE = ${scriptJson(state)};
    const REVIEWER_KEY = 'adminReview.reviewer';
    const FLASH_KEY = 'adminReview.flash';
    const WRONG_TEXT = 'wrong_text';
    let picked = STATE.choice;
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
    function openPlayer(link) {
        if (link) window.open(link, '_blank', 'noopener,noreferrer');
    }
    // Switching items also starts loading the new item's player behind the
    // review page. A page cannot open a tab behind itself, so the tabs swap
    // roles: the next item opens in a new tab in front, and this tab turns
    // into the player (the browser puts the new tab right after it). Runs
    // inside the key/click/save gesture, since the next page cannot open a
    // tab on load (popup blocker). Blocked popup or no link: plain navigation.
    // The new tab keeps its opener (the player tab), so saving can close it.
    function goTo(code, link) {
        if (link) {
            const tab = window.open(itemUrl(code), '_blank');
            if (tab) {
                window.location.href = link;
                return;
            }
        }
        window.location.href = itemUrl(code);
    }
    // After a save the item's player tab (this tab's opener after a switch) is
    // done with. The browser closes it only when a script opened it, so the
    // tab the review started in stays open.
    function closePlayerTab() {
        try {
            if (window.opener && !window.opener.closed) window.opener.close();
        } catch (e) { /* not closable: leave it */ }
    }
    function setStatus(text, kind) {
        const el = document.getElementById('status');
        el.textContent = text;
        el.className = 'status' + (kind ? ' ' + kind : '');
    }
    // Button → stored verdict: Wrong text saves as unclear.
    function verdictOf(choice) {
        return choice === WRONG_TEXT ? 'unclear' : choice;
    }
    // Wrong text puts its canned comment in front of the comment box; leaving
    // it for another button takes the canned text back out.
    function pick(v) {
        const box = document.getElementById('comment');
        const canned = STATE.wrong_text_comment;
        if (v === WRONG_TEXT && !box.value.startsWith(canned)) {
            box.value = box.value.trim() ? canned + '\\n' + box.value : canned;
        } else if (v !== WRONG_TEXT && picked === WRONG_TEXT && box.value.startsWith(canned)) {
            box.value = box.value.slice(canned.length).replace(/^\\n/, '');
        }
        picked = v;
        document.querySelectorAll('.verdict-btn').forEach(function (b) {
            b.classList.toggle('selected', b.dataset.verdict === v);
        });
        setStatus('');
    }
    async function save() {
        if (saving) return;
        if (!picked) { setStatus('Pick a verdict first (1–' + STATE.choices.length + ').', 'error'); return; }
        const verdict = verdictOf(picked);
        const comment = document.getElementById('comment').value;
        const reviewerEl = document.getElementById('reviewer');
        const reviewer = reviewerEl.value.trim();
        // A stray Enter on a decided item must not append a copy of its
        // verdict; another reviewer saving the same verdict is a new opinion.
        if (verdict === STATE.verdict && comment.trim() === STATE.comment
            && (reviewer === '' || reviewer === STATE.reviewer)) {
            setStatus('No change: ' + STATE.item_code + ' is already ' + verdict + '.');
            return;
        }
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
                    verdict: verdict,
                    comment: comment,
                    reviewer: reviewer,
                }),
            });
            if (res.status === 201) {
                const data = await res.json();
                const flagged = (data.flagged_by || []).join(', ') || '—';
                storageSet('sessionStorage', FLASH_KEY, 'Saved ' + STATE.item_code + ': ' + verdict + '. Flagged by: ' + flagged);
                closePlayerTab();
                if (data.next_item) goTo(data.next_item, data.next_player_link);
                else window.location.href = itemUrl(STATE.item_code);
                return;
            }
            setStatus('Error ' + res.status + ': ' + (await res.text()), 'error');
        } catch (err) {
            setStatus('Error: ' + err.message, 'error');
        }
        saving = false;
        btn.disabled = false;
    }
    // Letter hotkeys by key, or by physical key when the layout is not Latin
    // (a Russian layout gives с/о/л/щ for c/j/k/o).
    const LETTER_CODES = { KeyC: 'c', KeyJ: 'j', KeyK: 'k', KeyO: 'o' };
    document.addEventListener('keydown', function (e) {
        const el = e.target;
        const tag = el && el.tagName;
        const typing = tag === 'TEXTAREA' || tag === 'INPUT' || (el && el.isContentEditable);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); return; }
        if (typing) {
            if (e.key === 'Escape') el.blur();
            // Enter in the one-line Reviewer box saves (the first save sends the user there).
            else if (e.key === 'Enter' && el.id === 'reviewer') { e.preventDefault(); save(); }
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const digit = /^Digit([0-9])$/.exec(e.code || '');
        const n = digit ? Number(digit[1]) : Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= STATE.choices.length) { e.preventDefault(); pick(STATE.choices[n - 1]); return; }
        if (e.key === 'Enter') {
            // Enter on a focused link (e.g. after clicking "Open in player") keeps following it.
            if (tag === 'A') return;
            e.preventDefault(); save(); return;
        }
        const letter = /^[a-z]$/i.test(e.key) ? e.key.toLowerCase() : LETTER_CODES[e.code];
        switch (letter) {
            case 'c': e.preventDefault(); document.getElementById('comment').focus(); break;
            case 'j': if (STATE.next) goTo(STATE.next, STATE.next_player_link); break;
            case 'k': if (STATE.prev) goTo(STATE.prev, STATE.prev_player_link); break;
            case 'o': openPlayer(STATE.player_link); break;
        }
    });
    // Plain clicks on ◀ / ▶ / first open switch like j / k (a modified click
    // keeps the browser's meaning: the review page in a new tab, no player).
    document.addEventListener('click', function (e) {
        const a = e.target && e.target.closest ? e.target.closest('a.nav-btn[data-player-link]') : null;
        if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        goTo(a.dataset.itemCode, a.dataset.playerLink);
    });
    (function init() {
        document.getElementById('reviewer').value = storageGet('localStorage', REVIEWER_KEY) || '';
        const flash = storageGet('sessionStorage', FLASH_KEY);
        if (flash) { setStatus(flash, 'ok'); storageSet('sessionStorage', FLASH_KEY, null); }
    })();
</script>`);
}

// `models` is unused here; kept for the shared route-factory signature (see index.js).
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
        let row;
        try {
            row = await reviewRepository.recordVerdict({
                item_id: body.item_id,
                verdict: body.verdict,
                comment: body.comment,
                reviewer: body.reviewer,
                source: 'page',
            });
        } catch (err) {
            if (err instanceof ReviewInputError) {
                res.status(400).send(err.message);
                return;
            }
            throw err;
        }
        // The verdict comes from the row just written (another reviewer may
        // have decided the same item meanwhile); the item only adds code,
        // position and flagged_by.
        const item = await reviewRepository.getItemById(row.item_id);
        const next = await reviewRepository.nextOpenItem(item.batch, item.position);
        res.status(201).json({
            item_id: item.id,
            item_code: item.item_code,
            verdict: row.verdict,
            flagged_by: item.flagged_by || [],
            next_item: next ? next.item_code : null,
            next_player_link: next ? safeLink(next.link) : null,
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
            nav: { prev: presentNav(prev), next: presentNav(next), first_open: presentNav(firstOpen) },
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
