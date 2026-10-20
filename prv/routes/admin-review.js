const express = require('express');
const handler = require('../../middleware/handler');
const { VERDICTS, formatPlayerTime } = require('../../lib/review-sheet');
const { ReviewInputError, SIGNALS_WINDOW } = require('../repository/review');
const { CATEGORY_COLORS, escapeHtml, urlToken, formatDate } = require('../../lib/admin-html');
const { LANGS, COOKIE, translator, pickLang } = require('../../lib/i18n');

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

// Verdict buttons in hotkey order (1–4); 5 toggles the track flag.
const CHOICES = VERDICTS;
// Video-level flag saved next to the verdict: the subtitle track does not
// match the player (text or timing). Independent of the verdict: the verdict
// says what the text is, the flag says the video is not where the text is.
const TRACK_FLAG = 'track_mismatch';
const TRACK_KEY = CHOICES.length + 1;
// Legacy "Wrong text" verdicts (before 2026-10-18) are `unclear` with this
// comment in front; the page still shows them as such.
const WRONG_TEXT_COMMENT = 'Текст в видео не совпадает с текстом из субтитров.';

// Inline SVG icons (stroke = currentColor, Lucide-style 24×24 paths).
function icon(paths, cls = 'icon') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
const CHOICE_ICONS = {
    sponsor: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    self_promotion: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    not_ad: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    unclear: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
};
const QUOTE_ICON = '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>';

function isLegacyWrongText(verdict) {
    return verdict != null && verdict.verdict === 'unclear' && (verdict.comment || '').startsWith(WRONG_TEXT_COMMENT);
}

// Nav reference as the page shows it: the raw link becomes `player_link`
// (null when not http(s)), so switching items can open the player.
function presentNav(ref) {
    return ref ? { item_code: ref.item_code, decided: ref.decided, player_link: safeLink(ref.link) } : null;
}

// Same shape recordVerdict accepts; lets the decide route tell a bad id from
// an unknown item before touching the repository.
function validBodyItemId(id) {
    return Number.isInteger(id) && id > 0 && id <= 2147483647;
}

// Verdict-valued categories show the translated verdict label (as on the buttons).
function badge(category, t) {
    const color = CATEGORY_COLORS[category] || '#64748b';
    const label = VERDICTS.includes(category) ? t(`verdict_${category}`) : escapeHtml(category || '?');
    return `<span class="badge" style="background:${color}">${label}</span>`;
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
const LANG_COOKIE_MS = 365 * 24 * 3600 * 1000;

// Translator for the request; an explicit `?lang=` is remembered in the cookie.
function languageOf(req, res) {
    if (LANGS.includes(req.query.lang)) {
        res.cookie(COOKIE, req.query.lang, { path: '/admin/review', maxAge: LANG_COOKIE_MS, httpOnly: true, sameSite: 'lax' });
    }
    return translator(pickLang(req));
}

// The toolbar switch: this page with `lang` set to the other language.
function langSwitch(req, t, query = req.query) {
    const params = new URLSearchParams({ ...query, lang: LANGS.find(l => l !== t.lang) });
    return `<a class="lang-switch" href="${escapeHtml(`${req.baseUrl}${req.path}?${params}`)}">${t('lang_switch')}</a>`;
}

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
        .rules { font-size: 0.85rem; color: #cbd5e1; line-height: 1.5; }
        .rules li { margin-left: 18px; }
        .flag-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 12px; font-size: 0.9rem; }
        .flag-row input { width: 18px; height: 18px; accent-color: #f59e0b; }
        .flag-row .who { color: #64748b; font-size: 0.8rem; }
        .picker a { display: inline-block; background: #1e293b; border: 1px solid #334155; padding: 10px 18px; border-radius: 8px; margin: 0 10px 10px 0; font-size: 1rem; }
        .warn { color: #fcd34d; }
`;

function page(title, body, lang) {
    return `<!DOCTYPE html>
<html lang="${lang}">
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

function renderReviewerPicker(reviewers, token, t, langLink) {
    const tok = escapeHtml(urlToken(token));
    const links = reviewers.map(r =>
        `<a href="/admin/review?reviewer=${escapeHtml(encodeURIComponent(r))}&amp;verifyBearerToken=${tok}">${escapeHtml(r)}</a>`).join('');
    return page(t.text('page_title'), `
    <h1>${t('page_title')}</h1>
    <div class="toolbar"><span class="spacer"></span>${langLink}</div>
    <p class="muted" style="margin-bottom:14px">${t('picker_prompt')}</p>
    <div class="picker">${links || `<span class="empty">${t('picker_empty')}</span>`}</div>`, t.lang);
}

function renderBatchList(batches, reviewer, showAll, token, t, langLink) {
    const tok = escapeHtml(urlToken(token));
    const r = escapeHtml(encodeURIComponent(reviewer));
    const rows = batches.map(b => `
            <tr>
                <td><a class="batch-link" href="/admin/review/${escapeHtml(encodeURIComponent(b.batch))}?reviewer=${r}&amp;verifyBearerToken=${tok}">${escapeHtml(b.batch)}</a></td>
                <td>${t(`state_${b.state}`, { name: b.locked_by })}</td>
                <td class="num">${b.total}</td>
                <td class="num">${b.decided}</td>
                <td class="num">${b.open}</td>
            </tr>`).join('');
    return page(t.text('page_title'), `
    <h1>${t('page_title')}</h1>
    <div class="toolbar">
        <span>${t('toolbar_reviewer_html', { name: reviewer })}</span>
        <a href="/admin/review?verifyBearerToken=${tok}">${t('toolbar_switch')}</a>
        <span class="spacer"></span>
        ${showAll
        ? `<a href="/admin/review?reviewer=${r}&amp;verifyBearerToken=${tok}">${t('toolbar_my_batches')}</a>`
        : `<a href="/admin/review?reviewer=${r}&amp;show=all&amp;verifyBearerToken=${tok}">${t('toolbar_all_batches')}</a>`}
        <a href="/admin/review?reviewer=${r}&amp;format=json${showAll ? '&amp;show=all' : ''}&amp;verifyBearerToken=${tok}">${t('toolbar_json')}</a>
        ${langLink}
    </div>
    ${batches.length > 0 ? `
    <table>
        <thead><tr><th>${t('list_col_batch')}</th><th>${t('list_col_state')}</th><th>${t('list_col_items')}</th><th>${t('list_col_decided')}</th><th>${t('list_col_open')}</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>` : `<div class="card empty">${showAll ? t('list_empty_all') : t('list_empty_mine')}</div>`}
<script>
    // A batch opens in a tab this page opens: the item page later turns that
    // tab into a player and the browser lets a page close only tabs a script
    // opened (see closePlayerTab on the item page). Popup blocked: plain link.
    document.addEventListener('click', function (e) {
        const a = e.target && e.target.closest ? e.target.closest('a.batch-link') : null;
        if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        if (window.open(a.href, '_blank')) e.preventDefault();
    });
</script>`, t.lang);
}

function renderSignals(signals, token, t) {
    const tok = escapeHtml(urlToken(token));
    const range = `${formatPlayerTime(signals.window.start)} – ${formatPlayerTime(signals.window.end)}`;
    const videoLinks = signals.videos.map(v =>
        `<a href="/admin/video/${v.id}?verifyBearerToken=${tok}" target="_blank" rel="noopener">${v.duration != null
            ? t('signals_video_duration', { id: v.id, seconds: v.duration })
            : t('signals_video', { id: v.id })} ↗</a>`
    ).join(' · ');

    const markupRows = signals.markups.map(m => {
        const author = m.user_id != null
            ? `<a href="/admin/user/${Number(m.user_id)}?verifyBearerToken=${tok}" target="_blank" rel="noopener">${t('signals_user', { id: Number(m.user_id) })}</a>`
            : '<span class="muted">—</span>';
        return `
            <tr>
                <td>${badge(m.category, t)}</td>
                <td class="num">${formatPlayerTime(m.start)} – ${formatPlayerTime(m.end)}</td>
                <td>${author}${m.author_banned ? `<span class="badge badge-banned">${t('signals_banned')}</span>` : ''}</td>
                <td class="num">${m.author_rating != null ? escapeHtml(m.author_rating) : '—'}</td>
                <td class="num muted">${Number(m.markup_id)}</td>
            </tr>`;
    }).join('');

    const segmentRows = signals.segments.map(s => `
            <tr>
                <td>${badge(s.category, t)}</td>
                <td class="num">${formatPlayerTime(s.start)} – ${formatPlayerTime(s.end)}</td>
                <td class="num">${escapeHtml(s.rating)}</td>
                <td class="num">${Number(s.likes)} / ${Number(s.dislikes)}</td>
                <td class="num muted">${t('signals_video', { id: Number(s.video_id) })}</td>
            </tr>`).join('');

    return `
    <h2>${t('signals_title_html', { window: SIGNALS_WINDOW, range })}</h2>
    <div class="signals-line">
        ${t('signals_counts_html', { undos: Number(signals.undos), clicks: Number(signals.clicks) })}
        ${signals.videos.length > 0 ? ` · ${videoLinks}` : ` · <span class="muted">${t('signals_no_videos')}</span>`}
    </div>
    ${signals.markups.length > 0 ? `
    <table>
        <thead><tr><th>${t('signals_col_markup')}</th><th>${t('signals_col_interval')}</th><th>${t('signals_col_author')}</th><th>${t('signals_col_author_rating')}</th><th>${t('signals_col_id')}</th></tr></thead>
        <tbody>${markupRows}</tbody>
    </table>` : `<div class="empty">${t('signals_no_markups')}</div>`}
    ${signals.segments.length > 0 ? `
    <table>
        <thead><tr><th>${t('signals_col_segment')}</th><th>${t('signals_col_interval')}</th><th>${t('signals_col_rating')}</th><th>${t('signals_col_votes')}</th><th>${t('signals_col_video')}</th></tr></thead>
        <tbody>${segmentRows}</tbody>
    </table>` : `<div class="empty">${t('signals_no_segments')}</div>`}`;
}

function renderItemPage(payload, token, t, langLink) {
    const { batch, item, nav, signals, reviewer, video_flags } = payload;
    const tok = escapeHtml(urlToken(token));
    const r = escapeHtml(encodeURIComponent(reviewer));
    const itemHref = (code) =>
        `/admin/review/${escapeHtml(encodeURIComponent(batch.batch))}?item=${escapeHtml(encodeURIComponent(code))}&amp;reviewer=${r}&amp;verifyBearerToken=${tok}`;
    const navLink = (ref, label) => ref
        ? `<a class="nav-btn" href="${itemHref(ref.item_code)}" data-item-code="${escapeHtml(ref.item_code)}"${ref.player_link ? ` data-player-link="${escapeHtml(ref.player_link)}"` : ''}>${label}</a>`
        : `<span class="nav-btn disabled">${label}</span>`;

    const proposed = String(item.proposed || '').split('+').filter(Boolean).map(c => badge(c, t)).join(' ');
    const current = item.verdict;

    const decidedBlock = current ? `
    <div class="card">
        <div class="current">${t('current_verdict')} ${badge(current.verdict, t)}${isLegacyWrongText(current) ? ` <span class="warn">${t('current_legacy_wrong_text')}</span>` : ''}
            <span class="muted">${t('current_by', { reviewer: current.reviewer, source: current.source, date: formatDate(current.decided_at) })}</span></div>
        ${current.comment ? `<blockquote>${escapeHtml(current.comment)}</blockquote>` : ''}
        <div class="current flagged-by" style="margin-top:10px">${t('current_flagged_by')} ${(item.flagged_by || []).map(r => `<code>${escapeHtml(r)}</code>`).join(' ') || '<span class="muted">—</span>'}</div>
        <table>
            <thead><tr><th>${t('history_when')}</th><th>${t('history_verdict')}</th><th>${t('history_reviewer')}</th><th>${t('history_source')}</th><th>${t('history_comment')}</th></tr></thead>
            <tbody>${item.history.map(h => `
                <tr>
                    <td class="muted">${formatDate(h.decided_at)}</td>
                    <td>${badge(h.verdict, t)}</td>
                    <td>${escapeHtml(h.reviewer)}</td>
                    <td class="muted">${escapeHtml(h.source)}</td>
                    <td style="white-space:pre-wrap">${escapeHtml(h.comment || '')}</td>
                </tr>`).join('')}</tbody>
        </table>
    </div>` : '';

    const currentChoice = current ? current.verdict : null;
    const verdictButtons = CHOICES.map((v, i) => `
            <button type="button" class="verdict-btn${currentChoice === v ? ' selected' : ''}" data-verdict="${v}" onclick="pick('${v}')"><kbd>${i + 1}</kbd>${icon(CHOICE_ICONS[v])}${t(`verdict_${v}`)}</button>`).join('');
    const track = video_flags[TRACK_FLAG];
    const trackOn = track ? track.value === true : false;

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
        reviewer,
        verdict_reviewer: current ? current.reviewer : null,
        track_mismatch: trackOn,
        choices: CHOICES,
        verdict_labels: Object.fromEntries(CHOICES.map(v => [v, t.text(`verdict_${v}`)])),
        i18n: Object.fromEntries(['js_pick_first', 'js_no_change', 'js_saved', 'js_saved_track', 'js_close_by_hand', 'js_error_status', 'js_error']
            .map(key => [key, t.text(key)])),
    };

    return page(`${item.item_code} · ${batch.batch}`, `
    <div class="toolbar">
        <a href="/admin/review?reviewer=${r}&amp;verifyBearerToken=${tok}">${t('item_all_batches')}</a>
        <strong>${escapeHtml(batch.batch)}</strong>
        <span>${t('item_progress', { decided: batch.decided, total: batch.total, open: batch.open })}</span>
        <span class="muted">${t('item_reviewer_html', { name: reviewer })}${batch.locked_by && batch.locked_by !== reviewer ? ` <span class="warn">${t('item_locked_by', { name: batch.locked_by })}</span>` : ''}</span>
        <span class="spacer"></span>
        ${navLink(nav.prev, `◀ ${nav.prev ? escapeHtml(nav.prev.item_code) : ''}`)}
        <strong>${escapeHtml(item.item_code)}</strong>
        ${navLink(nav.next, `${nav.next ? escapeHtml(nav.next.item_code) : ''} ▶`)}
        ${navLink(nav.first_open, t('item_first_open'))}
        <a href="${itemHref(item.item_code)}&amp;format=json">${t('toolbar_json')}</a>
        ${langLink}
    </div>

    <div class="card">
        <div class="item-head">${t('item_duration', { start: item.start_player, end: item.end_player, seconds: item.duration_s })}</div>
        ${item.player_link
        ? `<a id="player-link" href="${escapeHtml(item.player_link)}" target="_blank" rel="noopener noreferrer">${t('item_open_player')}</a>
        <span class="muted">${t('item_player_offset')}</span>`
        : `<span class="muted">${t('item_no_player')}</span>`}
        ${item.cues ? `<div class="cues">${icon(QUOTE_ICON, 'quote-icon')}<div class="cues-text">${escapeHtml(item.cues)}</div></div>` : ''}
        <div class="muted item-id">${escapeHtml(item.item_code)} · ${escapeHtml(item.native_id)}</div>
    </div>

    ${decidedBlock}

    <div class="card">
        <div class="proposed"><span class="muted">${t('proposed_as')}</span> ${proposed}</div>
        <label>${t('verdict_prompt_html')}</label>
        <div class="verdicts">${verdictButtons}
        </div>
        <label>${t('video_label')}</label>
        <div class="flag-row">
            <input type="checkbox" id="track-flag"${trackOn ? ' checked' : ''} onchange="setStatus('')">
            <label for="track-flag" style="margin:0;color:#e2e8f0;font-size:0.9rem"><kbd>${TRACK_KEY}</kbd> ${t('track_flag')}</label>
            ${track ? `<span class="who">${t(track.value ? 'track_set_on' : 'track_set_off', { name: track.reviewer, date: formatDate(track.created_at) })}</span>` : ''}
        </div>
        <label for="comment">${t('comment_label')}</label>
        <textarea id="comment" style="width:100%">${escapeHtml(current && current.comment ? current.comment : '')}</textarea>
        <button type="button" class="save-btn" id="save-btn" onclick="save()">${t('save_button')}</button>
        <div class="status" id="status"></div>
    </div>

    <div class="card rules">
        <strong>${t('rules_title')}</strong>
        <ul>
            <li>${t('rules_who_paid_html')}</li>
            <li>${t('rules_call_to_action_html')}</li>
            <li>${t('rules_not_ad_html')}</li>
            <li>${t('rules_track_html')}</li>
        </ul>
    </div>

    ${renderSignals(signals, token, t)}

    <div class="muted hotkeys">${t('hotkeys_html', { n: CHOICES.length, flag: TRACK_KEY })}</div>

<script>
    const STATE = ${scriptJson(state)};
    const FLASH_KEY = 'adminReview.flash';
    let picked = STATE.choice;
    let saving = false;

    function tr(key, params) {
        return STATE.i18n[key].replace(/[{]([a-z_]+)[}]/g, function (m, name) {
            return params && params[name] != null ? String(params[name]) : m;
        });
    }

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
            + '&reviewer=' + encodeURIComponent(STATE.reviewer) + '&verifyBearerToken=' + encodeURIComponent(STATE.token);
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
    // done with. Only a cross-origin opener is a player: a same-origin one is
    // the batch list or a review page and stays. The browser closes only tabs
    // a script opened, so a player in a tab the reviewer opened stays.
    // Returns null (no player tab), true (closed) or false (still open).
    function closePlayerTab() {
        const tab = window.opener;
        if (!tab || tab.closed) return null;
        try { void tab.location.href; return null; } catch (e) { /* cross-origin: a player */ }
        try { tab.close(); } catch (e) { /* refused */ }
        return tab.closed;
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
    function toggleTrack() {
        const box = document.getElementById('track-flag');
        box.checked = !box.checked;
        setStatus('');
    }
    async function save() {
        if (saving) return;
        if (!picked) { setStatus(tr('js_pick_first', { n: STATE.choices.length }), 'error'); return; }
        const verdict = picked;
        const comment = document.getElementById('comment').value;
        const track = document.getElementById('track-flag').checked;
        // A stray Enter on a decided item must not append a copy of its
        // verdict; another reviewer saving the same verdict is a new opinion.
        // The server skips the duplicate row too; this only spares the round trip.
        if (verdict === STATE.verdict && comment.trim() === STATE.comment
            && STATE.reviewer === STATE.verdict_reviewer && track === STATE.track_mismatch) {
            setStatus(tr('js_no_change', { item: STATE.item_code, verdict: STATE.verdict_labels[verdict] }));
            return;
        }
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
                    reviewer: STATE.reviewer,
                    track_mismatch: track,
                }),
            });
            if (res.status === 201) {
                const data = await res.json();
                const flagged = (data.flagged_by || []).join(', ') || '—';
                let flash = tr('js_saved', {
                    item: STATE.item_code,
                    verdict: STATE.verdict_labels[verdict],
                    track: data.track_mismatch ? tr('js_saved_track') : '',
                    flagged: flagged,
                });
                if (closePlayerTab() === false) flash += '. ' + tr('js_close_by_hand');
                storageSet('sessionStorage', FLASH_KEY, flash);
                if (data.next_item) goTo(data.next_item, data.next_player_link);
                else window.location.href = itemUrl(STATE.item_code);
                return;
            }
            setStatus(tr('js_error_status', { status: res.status, text: await res.text() }), 'error');
        } catch (err) {
            setStatus(tr('js_error', { text: err.message }), 'error');
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
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const digit = /^Digit([0-9])$/.exec(e.code || '');
        const n = digit ? Number(digit[1]) : Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= STATE.choices.length) { e.preventDefault(); pick(STATE.choices[n - 1]); return; }
        if (n === STATE.choices.length + 1) { e.preventDefault(); toggleTrack(); return; }
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
        const flash = storageGet('sessionStorage', FLASH_KEY);
        if (flash) { setStatus(flash, 'ok'); storageSet('sessionStorage', FLASH_KEY, null); }
    })();
</script>`, t.lang);
}

// `models` is unused here; kept for the shared route-factory signature (see index.js).
module.exports = function createAdminReviewRoutes(models, { reviewRepository }) {
    const router = express.Router();

    // The reviewer travels in `?reviewer=` for the whole session (links and
    // saves carry it on). Returns the code, or null when missing or unknown.
    async function reviewerOf(req) {
        const code = typeof req.query.reviewer === 'string' ? req.query.reviewer.trim() : '';
        return code && await reviewRepository.isReviewer(code) ? code : null;
    }

    // GET /admin/review — reviewer picker, then the batch list with progress
    // and state for this reviewer (closed batches only with `show=all`).
    router.get('/admin/review', handler(async (req, res) => {
        if (!authorized(req, res)) return;
        const reviewer = await reviewerOf(req);
        if (!reviewer) {
            const reviewers = await reviewRepository.listReviewers();
            if (req.query.format === 'json') {
                res.status(req.query.reviewer ? 400 : 200).json({ reviewers, reviewer: null });
                return;
            }
            const t = languageOf(req, res);
            res.setHeader('Content-Type', 'text/html');
            res.send(renderReviewerPicker(reviewers, req.query.verifyBearerToken, t, langSwitch(req, t, { verifyBearerToken: req.query.verifyBearerToken })));
            return;
        }
        const showAll = req.query.show === 'all';
        const batches = await reviewRepository.listBatches({ reviewer, all: showAll });
        if (req.query.format === 'json') {
            res.json({ reviewer, batches });
            return;
        }
        const t = languageOf(req, res);
        res.setHeader('Content-Type', 'text/html');
        res.send(renderBatchList(batches, reviewer, showAll, req.query.verifyBearerToken, t, langSwitch(req, t)));
    }));

    // POST /admin/review/decide — append a verdict from the page, and the video
    // flag when it changed. Validation lives in the repository
    // (ReviewInputError → 400). A verdict identical to the item's latest one by
    // the same reviewer is not appended again (a flag-only save, a stray Enter).
    router.post('/admin/review/decide', handler(async (req, res) => {
        if (!authorized(req, res)) return;
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).send('request body must be a JSON object');
            return;
        }
        let item;
        try {
            if (!(await reviewRepository.isReviewer(typeof body.reviewer === 'string' ? body.reviewer.trim() : ''))) {
                throw new ReviewInputError(`unknown reviewer ${body.reviewer}`);
            }
            const reviewer = body.reviewer.trim();
            if (body.track_mismatch !== undefined && typeof body.track_mismatch !== 'boolean') {
                throw new ReviewInputError('track_mismatch must be true or false');
            }
            const before = await reviewRepository.getItemById(body.item_id);
            if (!before && !validBodyItemId(body.item_id)) throw new ReviewInputError('item_id must be a positive integer');
            if (!before) throw new ReviewInputError(`unknown review item ${body.item_id}`);
            const comment = body.comment == null ? null : body.comment;
            const text = typeof comment === 'string' ? comment.trim() : comment;
            const same = before.verdict && before.verdict.verdict === body.verdict
                && (before.verdict.comment || null) === (text === '' ? null : text)
                && before.verdict.reviewer === reviewer;
            if (!same) {
                await reviewRepository.recordVerdict({ item_id: body.item_id, verdict: body.verdict, comment, reviewer, source: 'page' });
            }
            if (body.track_mismatch !== undefined) {
                const current = await reviewRepository.getVideoFlag(before.native_id, TRACK_FLAG);
                if ((current ? current.value : false) !== body.track_mismatch) {
                    await reviewRepository.setVideoFlag({ native_id: before.native_id, flag: TRACK_FLAG, value: body.track_mismatch, reviewer });
                }
            }
            item = await reviewRepository.getItemById(body.item_id);
        } catch (err) {
            if (err instanceof ReviewInputError) {
                res.status(400).send(err.message);
                return;
            }
            throw err;
        }
        // The verdict is the item's latest (another reviewer may have decided
        // the same item meanwhile).
        const [next, track] = await Promise.all([
            reviewRepository.nextOpenItem(item.batch, item.position),
            reviewRepository.getVideoFlag(item.native_id, TRACK_FLAG),
        ]);
        res.status(201).json({
            item_id: item.id,
            item_code: item.item_code,
            verdict: item.verdict.verdict,
            track_mismatch: track ? track.value : false,
            flagged_by: item.flagged_by || [],
            next_item: next ? next.item_code : null,
            next_player_link: next ? safeLink(next.link) : null,
        });
    }));

    // GET /admin/review/:batch?item=C7 — item page; without `item` the first
    // open item (or the last one when the batch is done). Needs a reviewer:
    // without one the HTML goes back to the picker, JSON gets 400.
    router.get('/admin/review/:batch', handler(async (req, res) => {
        if (!authorized(req, res)) return;
        const reviewer = await reviewerOf(req);
        if (!reviewer) {
            if (req.query.format === 'json') { res.status(400).send('reviewer required'); return; }
            res.redirect(302, `/admin/review?verifyBearerToken=${encodeURIComponent(req.query.verifyBearerToken)}`);
            return;
        }
        const batchName = req.params.batch;
        const progress = await reviewRepository.getBatchProgress(batchName, reviewer);
        if (!progress) { res.status(404).send('Batch not found'); return; }

        const code = typeof req.query.item === 'string' ? req.query.item.trim() : '';
        const raw = code
            ? await reviewRepository.getItem(batchName, code)
            : await reviewRepository.defaultItem(batchName);
        if (!raw) { res.status(404).send('Item not found'); return; }

        const item = presentItem(raw);
        const [{ prev, next }, firstOpen, signals, track] = await Promise.all([
            reviewRepository.neighbours(batchName, item.position),
            reviewRepository.firstOpenItem(batchName),
            reviewRepository.getSignals(item.native_id, item.start, item.end),
            reviewRepository.getVideoFlag(item.native_id, TRACK_FLAG),
        ]);
        const payload = {
            reviewer,
            batch: progress,
            item,
            video_flags: { [TRACK_FLAG]: track },
            nav: { prev: presentNav(prev), next: presentNav(next), first_open: presentNav(firstOpen) },
            signals,
        };

        if (req.query.format === 'json') {
            res.json(payload);
            return;
        }
        const t = languageOf(req, res);
        res.setHeader('Content-Type', 'text/html');
        res.send(renderItemPage(payload, req.query.verifyBearerToken, t, langSwitch(req, t)));
    }));

    return router;
};
