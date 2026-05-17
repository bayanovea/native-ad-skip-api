const express = require('express');
const { QueryTypes } = require('sequelize');
const handler = require('../../middleware/handler');

// Tunable constants. Scoring weights (WEIGHT_DISLIKE/WEIGHT_UNDO/WEIGHT_SEGMENT_RATING)
// and UNDO_MATCH_TOLERANCE live in `prv/repository/moderation.js` since they
// are only consumed by that file's SQL. AUTO_BAN_RATING_THRESHOLD (-100) lives
// in `prv/service/user.js`. UNDO_MATCH_TOLERANCE is re-declared here because
// closestMarkupForTarget accepts it as a parameter.
//
// The re-surface filter is now applied INSIDE the scoreboard SQL (via the
// `resurfaceThreshold` parameter) so the LIMIT runs AFTER suppression. No
// over-fetching is needed — a single SCOREBOARD_LIMIT SQL fetch returns
// exactly the rows we render.
const RESURFACE_THRESHOLD = 5;
const SCOREBOARD_LIMIT = 50;
const HISTORY_LIMIT = 50;
const RECENT_DAYS = 7;
const UNDO_MATCH_TOLERANCE = 2;

function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// URL-encode a token before embedding it into an href query string. AUTH_TOKEN
// is admin-controlled but can contain URL-reserved chars (&, =, #, ?, +, %)
// that would otherwise break query-string parsing. encodeURIComponent always
// yields URL-safe ASCII (no <>&"'), so the subsequent escapeHtml pass over the
// result is a no-op — but we keep both for defense-in-depth and to match the
// HTML-escape pattern used everywhere else in this file. Inline <script>
// blocks use encodeURIComponent directly at runtime; this helper covers the
// server-rendered <a href> case.
function urlToken(value) {
    if (value == null) return '';
    return encodeURIComponent(String(value));
}

function formatDate(value) {
    if (value == null) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

module.exports = function createAdminModerationRoutes(models, { markupRepository, moderationRepository }) {
    const router = express.Router();
    const sequelize = models.Markup.sequelize;

    router.get('/admin/moderation', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        // 1. Scoreboards
        //
        // Re-surface suppression is now applied INSIDE the scoreboard SQL via
        // `resurfaceThreshold`. The SQL LEFT JOINs the latest decision per
        // target and drops rows whose score has not grown by at least
        // RESURFACE_THRESHOLD since that snapshot — so a single SCOREBOARD_LIMIT
        // fetch returns exactly the rows we render, with no JS-side filter and
        // no over-fetch needed. `?show=all` disables suppression entirely.
        const showAll = req.query.show === 'all';
        const resurfaceThreshold = showAll ? null : RESURFACE_THRESHOLD;

        const [userRows, markupRows] = await Promise.all([
            moderationRepository.getUserScoreboard({ limit: SCOREBOARD_LIMIT, recentDays: RECENT_DAYS, resurfaceThreshold }),
            moderationRepository.getMarkupScoreboard({ limit: SCOREBOARD_LIMIT, recentDays: RECENT_DAYS, resurfaceThreshold }),
        ]);

        const userIds = userRows.map(r => Number(r.user_id)).filter(id => Number.isFinite(id));
        const markupIds = markupRows.map(r => Number(r.markup_id)).filter(id => Number.isFinite(id));

        // Even though the SQL already suppressed not-yet-resurfaced rows, we
        // still attach `last_decision` to each surviving row so the HTML/JSON
        // can show "last decision was X N days ago" context for admins.
        const [userDecisionsMap, markupDecisionsMap] = await Promise.all([
            moderationRepository.getLatestDecisionsMap('user', userIds),
            moderationRepository.getLatestDecisionsMap('markup', markupIds),
        ]);

        for (const row of userRows) {
            row.last_decision = userDecisionsMap.get(Number(row.user_id)) || null;
        }
        for (const row of markupRows) {
            row.last_decision = markupDecisionsMap.get(Number(row.markup_id)) || null;
        }

        const visibleUsers = userRows;
        const visibleMarkups = markupRows;

        // 3. Context sections
        const recentDislikesRaw = await models.Vote.findAll({
            where: { vote: -1 },
            order: [['createdAt', 'DESC']],
            limit: HISTORY_LIMIT,
        });

        const recentUndosRaw = await models.IntervalUndo.findAll({
            order: [['createdAt', 'DESC']],
            limit: HISTORY_LIMIT,
        });

        // Pre-load videos referenced by votes (for native_id display).
        const voteVideoIds = [...new Set(recentDislikesRaw.map(v => v.video_id).filter(Boolean))];
        const videoById = new Map();
        if (voteVideoIds.length > 0) {
            const videos = await models.Video.findAll({ where: { id: voteVideoIds } });
            for (const v of videos) videoById.set(v.id, v);
        }

        // Resolve `closest markup` for each dislike. Parallelize the closest-
        // match SQL calls, then do ONE batched User lookup for author prv ids
        // (mirrors the videoById/videoByNative batching pattern above).
        const dislikeClosests = await Promise.all(recentDislikesRaw.map(vote => (
            moderationRepository.closestMarkupForTarget({
                video_id: vote.video_id,
                category_id: vote.category_id,
                start: vote.start,
                end: vote.end,
                tolerance: 0,
            })
        )));

        // For undos: video_native_id is on the row directly, but we need
        // video_id to call closestMarkupForTarget.
        //
        // Order by `id ASC` so that when multiple Video rows share a native_id
        // (a video-integrity issue this same page also surfaces) the chosen
        // video.id for undo attribution is deterministic — always the lowest
        // matching id. Without ORDER BY, Postgres is free to return rows in
        // any order, which would make undo attribution flicker across reloads.
        const undoNativeIds = [...new Set(recentUndosRaw.map(u => u.video_native_id).filter(Boolean))];
        const videoByNative = new Map();
        if (undoNativeIds.length > 0) {
            const videos = await models.Video.findAll({
                where: { native_id: undoNativeIds },
                order: [['id', 'ASC']],
            });
            // If multiple rows per native_id exist, keep the lowest-id one
            // (first encountered after ORDER BY id ASC). This view is
            // informational; the video-integrity section above flags the
            // duplicates separately so the admin can investigate.
            for (const v of videos) {
                if (!videoByNative.has(v.native_id)) videoByNative.set(v.native_id, v);
            }
        }

        const undoClosests = await Promise.all(recentUndosRaw.map(undo => {
            const video = videoByNative.get(undo.video_native_id);
            if (!video) return Promise.resolve(null);
            return moderationRepository.closestMarkupForTarget({
                video_id: video.id,
                category_id: undo.category_id,
                start: undo.start,
                end: undo.end,
                tolerance: UNDO_MATCH_TOLERANCE,
            });
        }));

        // One batched User.findAll for all attributed-author internal_user_ids
        // across both dislikes and undos — kills the N+1.
        const authorIds = new Set();
        for (const c of dislikeClosests) if (c && c.internal_user_id != null) authorIds.add(c.internal_user_id);
        for (const c of undoClosests) if (c && c.internal_user_id != null) authorIds.add(c.internal_user_id);
        const authorById = new Map();
        if (authorIds.size > 0) {
            const authors = await models.User.findAll({
                where: { id: [...authorIds] },
                attributes: ['id', 'prv_user_id'],
            });
            for (const a of authors) authorById.set(a.id, a);
        }

        const buildAttribution = (closest) => {
            if (!closest) return null;
            const author = closest.internal_user_id != null ? authorById.get(closest.internal_user_id) : null;
            return {
                markup_id: closest.id,
                author_user_id: closest.internal_user_id,
                author_prv_user_id: author ? author.prv_user_id : null,
            };
        };

        const recent_dislikes = recentDislikesRaw.map((vote, i) => {
            const video = videoById.get(vote.video_id) || null;
            return {
                id: vote.id,
                video_id: vote.video_id,
                video_native_id: video ? video.native_id : null,
                category_id: vote.category_id,
                start: vote.start,
                end: vote.end,
                user_id: vote.user_id,
                createdAt: vote.createdAt,
                attributed_markup: buildAttribution(dislikeClosests[i]),
            };
        });

        const recent_undos = recentUndosRaw.map((undo, i) => ({
            id: undo.id,
            video_native_id: undo.video_native_id,
            category_id: undo.category_id,
            start: undo.start,
            end: undo.end,
            user_id: undo.user_id,
            createdAt: undo.createdAt,
            attributed_markup: buildAttribution(undoClosests[i]),
        }));

        // 4. Video integrity
        const duplicate_native_id = await sequelize.query(
            `SELECT native_id, COUNT(*)::int AS row_count, COUNT(DISTINCT duration)::int AS distinct_durations
             FROM videos
             GROUP BY native_id
             HAVING COUNT(*) > 1
             ORDER BY row_count DESC
             LIMIT 50`,
            { type: QueryTypes.SELECT }
        );

        const duration_outliers = await sequelize.query(
            `SELECT v.id, v.native_id, v.duration,
                    COUNT(dl.id)::int     AS log_count,
                    MIN(dl.duration)::int AS min_claim,
                    MAX(dl.duration)::int AS max_claim
             FROM videos v
             JOIN duration_logs dl ON dl.video_id = v.id
             GROUP BY v.id, v.native_id, v.duration
             HAVING (MAX(dl.duration) - MIN(dl.duration)) > 3
                 OR ABS(COALESCE(v.duration, 0) - AVG(dl.duration)) > 3
             ORDER BY log_count DESC
             LIMIT 50`,
            { type: QueryTypes.SELECT }
        );

        const video_integrity = { duplicate_native_id, duration_outliers };

        // 5. Decision history — ORDER BY decided_at DESC, id DESC matches the
        // tiebreak used by getLatestDecisionsMap so both views are stable.
        const historyRows = await models.AdminDecision.findAll({
            order: [['decided_at', 'DESC'], ['id', 'DESC']],
            limit: HISTORY_LIMIT,
        });
        const history = historyRows.map(r => r.toJSON());

        // 6. Compose response payload.
        // NOTE: `prv_user_id` in markups[] rows is the markup AUTHOR's prv_user_id
        // (joined from users via markups.internal_user_id), NOT the markup row's
        // own stored prv_user_id. The JSON contract is locked by tests — see plan.
        const users = visibleUsers.map(r => ({
            user_id: Number(r.user_id),
            prv_user_id: r.prv_user_id != null ? Number(r.prv_user_id) : null,
            score: Number(r.score) || 0,
            dislikes: Number(r.dislikes) || 0,
            dislikes_7d: Number(r.dislikes_7d) || 0,
            undos: Number(r.undos) || 0,
            undos_7d: Number(r.undos_7d) || 0,
            rating: Number(r.rating) || 0,
            markups_total: Number(r.markups_total) || 0,
            markups_recent: Number(r.markups_recent) || 0,
            banned_at: r.banned_at || null,
            last_decision: r.last_decision || null,
        }));

        const markups = visibleMarkups.map(r => ({
            markup_id: Number(r.markup_id),
            score: Number(r.score) || 0,
            dislikes: Number(r.dislikes) || 0,
            dislikes_7d: Number(r.dislikes_7d) || 0,
            undos: Number(r.undos) || 0,
            undos_7d: Number(r.undos_7d) || 0,
            segment_rating: Number(r.segment_rating) || 0,
            user_id: r.user_id != null ? Number(r.user_id) : null,
            prv_user_id: r.prv_user_id != null ? Number(r.prv_user_id) : null,
            video_id: r.video_id != null ? Number(r.video_id) : null,
            video_native_id: r.video_native_id || null,
            last_decision: r.last_decision || null,
        }));

        const payload = { users, markups, recent_dislikes, recent_undos, video_integrity, history };

        if (req.query.format === 'json') {
            res.json(payload);
            return;
        }

        // 7. HTML render
        const token = req.query.verifyBearerToken;

        const userTableRows = users.map(u => {
            const decisionText = u.last_decision
                ? `${escapeHtml(u.last_decision.decision)} by ${escapeHtml(u.last_decision.decided_by)} (${formatDate(u.last_decision.decided_at)})`
                : '—';
            const bannedBadge = u.banned_at ? `<span class="badge badge-banned">banned ${formatDate(u.banned_at)}</span>` : '';
            // Link to the video-less user view; fall back to plain text when no prv_user_id.
            // Link param is the internal user id (unique PK), NOT prv_user_id.
            // prv_user_id is not unique — multiple User rows can share the same
            // prv_user_id (one per generated_user_id × prv_user_id combo) and
            // findOne({where:{prv_user_id}}) would pick an arbitrary one. The
            // display label still shows prv_user_id (the human-recognizable id).
            const userCell = u.prv_user_id != null
                ? `<a href="/admin/user/${u.user_id}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank">User ${escapeHtml(u.prv_user_id)}</a>`
                : `<a href="/admin/user/${u.user_id}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank" class="muted">user #${u.user_id}</a>`;
            return `
            <tr data-user-id="${u.user_id}">
                <td class="num">${u.score}</td>
                <td>${userCell} ${bannedBadge}</td>
                <td class="num">${u.dislikes}<span class="muted"> / ${u.dislikes_7d} (7d)</span></td>
                <td class="num">${u.undos}<span class="muted"> / ${u.undos_7d} (7d)</span></td>
                <td class="num">${u.rating}</td>
                <td class="num">${u.markups_total}<span class="muted"> / ${u.markups_recent} (7d)</span></td>
                <td class="muted">${decisionText}</td>
                <td>
                    <button class="btn-reject" onclick="decide('user', ${u.user_id}, 'reject', this)">Ban</button>
                    <button class="btn-approve" onclick="decide('user', ${u.user_id}, 'approve', this)">Approve</button>
                </td>
            </tr>`;
        }).join('');

        const markupTableRows = markups.map(m => {
            const decisionText = m.last_decision
                ? `${escapeHtml(m.last_decision.decision)} by ${escapeHtml(m.last_decision.decided_by)} (${formatDate(m.last_decision.decided_at)})`
                : '—';
            const videoLink = m.video_id != null
                ? `<a href="/admin/video/${m.video_id}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank">${escapeHtml(m.video_native_id || m.video_id)}</a>`
                : '<span class="muted">—</span>';
            // See note above on userCell: link param is internal user id, not prv_user_id.
            const markupUserCell = m.user_id != null
                ? (m.prv_user_id != null
                    ? `<a href="/admin/user/${m.user_id}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank">User ${escapeHtml(m.prv_user_id)}</a>`
                    : `<a href="/admin/user/${m.user_id}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank" class="muted">user #${m.user_id}</a>`)
                : '<span class="muted">—</span>';
            return `
            <tr data-markup-id="${m.markup_id}">
                <td class="num">${m.score}</td>
                <td class="num">${m.markup_id}</td>
                <td>${markupUserCell}</td>
                <td>${videoLink}</td>
                <td class="num">${m.dislikes}<span class="muted"> / ${m.dislikes_7d} (7d)</span></td>
                <td class="num">${m.undos}<span class="muted"> / ${m.undos_7d} (7d)</span></td>
                <td class="num">${m.segment_rating}</td>
                <td class="muted">${decisionText}</td>
                <td>
                    <button class="btn-reject" onclick="decide('markup', ${m.markup_id}, 'reject', this)">Delete</button>
                    <button class="btn-approve" onclick="decide('markup', ${m.markup_id}, 'approve', this)">Approve</button>
                </td>
            </tr>`;
        }).join('');

        const dislikeRows = recent_dislikes.map(d => {
            const attrib = d.attributed_markup
                ? `${d.attributed_markup.markup_id} (prv ${escapeHtml(d.attributed_markup.author_prv_user_id ?? '—')})`
                : '<span class="muted">—</span>';
            return `
            <tr>
                <td class="muted">${formatDate(d.createdAt)}</td>
                <td>${escapeHtml(d.video_native_id || d.video_id)}</td>
                <td class="num">${d.category_id}</td>
                <td class="num">${d.start}—${d.end}</td>
                <td>${escapeHtml(d.user_id || '—')}</td>
                <td>${attrib}</td>
            </tr>`;
        }).join('');

        const undoRows = recent_undos.map(u => {
            const attrib = u.attributed_markup
                ? `${u.attributed_markup.markup_id} (prv ${escapeHtml(u.attributed_markup.author_prv_user_id ?? '—')})`
                : '<span class="muted">—</span>';
            return `
            <tr>
                <td class="muted">${formatDate(u.createdAt)}</td>
                <td>${escapeHtml(u.video_native_id)}</td>
                <td class="num">${u.category_id}</td>
                <td class="num">${u.start}—${u.end}</td>
                <td>${escapeHtml(u.user_id || '—')}</td>
                <td>${attrib}</td>
            </tr>`;
        }).join('');

        const dupRows = video_integrity.duplicate_native_id.map(r => `
            <tr>
                <td>${escapeHtml(r.native_id)}</td>
                <td class="num">${r.row_count}</td>
                <td class="num">${r.distinct_durations}</td>
            </tr>`).join('');

        const outlierRows = video_integrity.duration_outliers.map(r => `
            <tr>
                <td class="num">${r.id}</td>
                <td>${escapeHtml(r.native_id)}</td>
                <td class="num">${r.duration ?? '—'}</td>
                <td class="num">${r.log_count}</td>
                <td class="num">${r.min_claim}–${r.max_claim}</td>
            </tr>`).join('');

        const historyRowsHtml = history.map(h => `
            <tr>
                <td class="muted">${formatDate(h.decided_at)}</td>
                <td>${escapeHtml(h.target_type)}</td>
                <td class="num">${h.target_id}</td>
                <td>${escapeHtml(h.decision)}</td>
                <td>${escapeHtml(h.decided_by)}</td>
                <td class="muted"><code>${escapeHtml(JSON.stringify(h.signals_snapshot || {}))}</code></td>
            </tr>`).join('');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Moderation</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
        h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
        h2 { font-size: 1.05rem; font-weight: 600; margin: 28px 0 10px; color: #cbd5f5; }
        .meta { color: #94a3b8; font-size: 0.85rem; margin-bottom: 16px; }
        .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
        .toolbar a { color: #93c5fd; text-decoration: none; font-size: 0.85rem; }
        .toolbar a:hover { text-decoration: underline; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; margin-bottom: 8px; }
        thead tr { background: #0f172a; }
        th { text-align: left; padding: 8px 12px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 600; }
        td { padding: 8px 12px; font-size: 0.85rem; vertical-align: middle; border-top: 1px solid #0f172a; }
        td.num { font-variant-numeric: tabular-nums; }
        .muted { color: #64748b; font-size: 0.78rem; }
        a { color: #93c5fd; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.7rem; font-weight: 600; color: #fff; margin-left: 6px; }
        .badge-banned { background: #7f1d1d; color: #fecaca; }
        .btn-reject, .btn-approve { border: none; font-size: 0.75rem; padding: 3px 10px; border-radius: 4px; cursor: pointer; margin-right: 4px; }
        .btn-reject { background: #7f1d1d; color: #fca5a5; }
        .btn-reject:hover { background: #991b1b; }
        .btn-approve { background: #14532d; color: #bbf7d0; }
        .btn-approve:hover { background: #166534; }
        .btn-reject:disabled, .btn-approve:disabled { opacity: 0.5; cursor: default; }
        code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.72rem; background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #93c5fd; }
        .empty { background: #1e293b; border-radius: 10px; padding: 14px; color: #64748b; font-size: 0.85rem; margin-bottom: 8px; }
    </style>
</head>
<body>
    <h1>Moderation</h1>
    <div class="meta">
        Scoreboard limit ${SCOREBOARD_LIMIT}, recent window ${RECENT_DAYS}d, re-surface threshold ${RESURFACE_THRESHOLD}.
    </div>
    <div class="toolbar">
        ${showAll
            ? `<a href="/admin/moderation?verifyBearerToken=${escapeHtml(urlToken(token))}">Hide already-decided</a>`
            : `<a href="/admin/moderation?show=all&amp;verifyBearerToken=${escapeHtml(urlToken(token))}">Show all (including decided)</a>`
        }
        <a href="/admin/moderation?format=json&amp;verifyBearerToken=${escapeHtml(urlToken(token))}${showAll ? '&amp;show=all' : ''}">JSON</a>
    </div>

    <h2>Users (${users.length})</h2>
    ${users.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>Score</th>
                <th>prv user</th>
                <th>Dislikes</th>
                <th>Undos</th>
                <th>Rating</th>
                <th>Markups</th>
                <th>Last decision</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>${userTableRows}</tbody>
    </table>` : '<div class="empty">No users to surface.</div>'}

    <h2>Markups (${markups.length})</h2>
    ${markups.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>Score</th>
                <th>Markup id</th>
                <th>prv user</th>
                <th>Video</th>
                <th>Dislikes</th>
                <th>Undos</th>
                <th>Seg rating</th>
                <th>Last decision</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>${markupTableRows}</tbody>
    </table>` : '<div class="empty">No markups to surface.</div>'}

    <h2>Recent dislikes (last ${HISTORY_LIMIT})</h2>
    ${recent_dislikes.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>When</th>
                <th>Video</th>
                <th>Cat</th>
                <th>Interval</th>
                <th>Voter</th>
                <th>Attributed markup</th>
            </tr>
        </thead>
        <tbody>${dislikeRows}</tbody>
    </table>` : '<div class="empty">No recent dislikes.</div>'}

    <h2>Recent undos (last ${HISTORY_LIMIT})</h2>
    ${recent_undos.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>When</th>
                <th>Video</th>
                <th>Cat</th>
                <th>Interval</th>
                <th>Undoer</th>
                <th>Attributed markup</th>
            </tr>
        </thead>
        <tbody>${undoRows}</tbody>
    </table>` : '<div class="empty">No recent undos.</div>'}

    <h2>Video integrity — duplicate native_id (${video_integrity.duplicate_native_id.length})</h2>
    ${video_integrity.duplicate_native_id.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>native_id</th>
                <th>Rows</th>
                <th>Distinct durations</th>
            </tr>
        </thead>
        <tbody>${dupRows}</tbody>
    </table>` : '<div class="empty">No duplicates.</div>'}

    <h2>Video integrity — duration outliers (${video_integrity.duration_outliers.length})</h2>
    ${video_integrity.duration_outliers.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>Video id</th>
                <th>native_id</th>
                <th>Stored dur</th>
                <th>Log count</th>
                <th>Claim range</th>
            </tr>
        </thead>
        <tbody>${outlierRows}</tbody>
    </table>` : '<div class="empty">No outliers.</div>'}

    <h2>Decision history (last ${HISTORY_LIMIT})</h2>
    ${history.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>When</th>
                <th>Target</th>
                <th>Id</th>
                <th>Decision</th>
                <th>By</th>
                <th>Snapshot</th>
            </tr>
        </thead>
        <tbody>${historyRowsHtml}</tbody>
    </table>` : '<div class="empty">No decisions yet.</div>'}

<script>
    const AUTH_TOKEN = ${JSON.stringify(token).replace(/</g, '\\u003c')};
    async function decide(target_type, target_id, decision, btn) {
        const verb = decision === 'reject' ? (target_type === 'user' ? 'Ban' : 'Delete') : 'Approve';
        if (!confirm(verb + ' ' + target_type + ' ' + target_id + '?')) return;
        const row = btn.closest('tr');
        const buttons = row.querySelectorAll('button');
        buttons.forEach(b => { b.disabled = true; });
        try {
            const res = await fetch('/admin/moderation/decide?verifyBearerToken=' + encodeURIComponent(AUTH_TOKEN), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ target_type, target_id, decision }),
            });
            if (res.ok) {
                row.style.opacity = '0.4';
            } else {
                buttons.forEach(b => { b.disabled = false; });
                alert('Error: ' + res.status);
            }
        } catch (err) {
            buttons.forEach(b => { b.disabled = false; });
            alert('Error: ' + err.message);
        }
    }
</script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    }));

    // POST /admin/moderation/decide — apply a moderation decision against a
    // user or markup. Mutually-exclusive side effect per (target_type, decision)
    // combo; in every case a snapshot row lands in `prv_admin_decisions` via
    // `moderationRepository.recordDecision`.
    //
    // The whole flow runs in a single outer transaction so the decision row,
    // the snapshot (which queries live signals), and the side effect commit or
    // roll back atomically. `recordDecision` runs FIRST so the snapshot
    // reflects the markup/user state at decision time — for `markup + reject`
    // this means the markup is still un-deleted while we capture its score.
    router.post('/admin/moderation/decide', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        // Inline body validation — body must be JSON; if Express did not parse
        // it, treat as bad input. Error shapes are plain text to match other
        // admin routes (admin.js, markups.js).
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).send('request body must be a JSON object');
            return;
        }

        const { target_type, decision } = body;
        const target_id = Number(body.target_id);

        if (target_type !== 'user' && target_type !== 'markup') {
            res.status(400).send("target_type must be 'user' or 'markup'");
            return;
        }
        if (!Number.isInteger(target_id) || target_id <= 0) {
            res.status(400).send('target_id must be a positive integer');
            return;
        }
        if (decision !== 'approve' && decision !== 'reject') {
            res.status(400).send("decision must be 'approve' or 'reject'");
            return;
        }

        // Lookup target BEFORE opening the transaction. 404 is cheap and
        // avoids holding a transaction for a no-op.
        let user = null;
        let markup = null;
        if (target_type === 'user') {
            user = await models.User.findByPk(target_id);
            if (!user) { res.status(404).send('Not found'); return; }
        } else {
            markup = await markupRepository.findByPk(target_id);
            if (!markup) { res.status(404).send('Not found'); return; }
        }

        await sequelize.transaction(async (transaction) => {
            // 1. Record the decision row FIRST so the snapshot captures live
            //    state (before any side effect mutates the target).
            await moderationRepository.recordDecision({
                target_type,
                target_id,
                decision,
                decided_by: 'admin',
                transaction,
            });

            // 2. Apply the SINGLE side effect for (target_type, decision).
            if (target_type === 'user' && decision === 'reject') {
                if (user.banned_at == null) {
                    await user.update({ banned_at: new Date() }, { transaction });
                }
            } else if (target_type === 'user' && decision === 'approve') {
                if (user.banned_at != null) {
                    await user.update({ banned_at: null }, { transaction });
                }
            } else if (target_type === 'markup' && decision === 'reject') {
                // Soft-delete joins the outer transaction (we pass it in) so the
                // decision row, soft-delete, and sibling-update all commit or
                // roll back together.
                await markupRepository.softDeleteByIds([target_id], 'admin', null, { transaction });

                // Sibling check uses the outer transaction so it sees the just-
                // soft-deleted target as excluded (markupRepository.findAll
                // already filters deleted_at IS NULL).
                const videoMarkups = await markupRepository.findAll({
                    where: { video_id: markup.video_id },
                    transaction,
                });
                if (videoMarkups.length > 0) {
                    // Filter `deleted_at IS NULL` so we don't flip the just-
                    // soft-deleted target back to is_new=true.
                    await models.Markup.update(
                        { is_new: true },
                        { where: { video_id: markup.video_id, deleted_at: null }, transaction }
                    );
                } else {
                    await models.VideoCalculated.destroy({
                        where: { video_id: markup.video_id },
                        transaction,
                    });
                }
            }
            // markup + approve: decision row alone is the side effect — no-op here.
        });

        res.status(204).send();
    }));

    // GET /admin/user/:internal_id — video-less user view. Lists every markup
    // the user has authored across every video, including soft-deleted ones
    // (so admin can see deletion history). Styled to mirror the per-video
    // user view in prv/routes/admin.js.
    //
    // Param is the internal users.id (PK), NOT prv_user_id: prv_user_id is not
    // unique in the schema (the unique index is on
    // (generated_user_id, prv_user_id), so the same prv_user_id can repeat
    // across rows that differ by generated_user_id). Linking via internal id
    // disambiguates without merging accounts.
    router.get('/admin/user/:internal_id', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        const internalId = parseInt(req.params.internal_id, 10);
        if (!Number.isInteger(internalId) || internalId <= 0) {
            res.status(400).send('Bad internal_id');
            return;
        }

        const user = await models.User.findByPk(internalId);
        if (!user) { res.status(404).send('User not found'); return; }

        // Include soft-deleted markups so admin sees the full history.
        const markups = await models.Markup.findAll({
            where: { internal_user_id: user.id },
            include: [
                { model: models.MarkupCategory, as: 'category' },
                { model: models.Video, as: 'video' },
            ],
            order: [['id', 'ASC']],
        });

        const markupIds = markups.map(m => m.id);
        const intervals = markupIds.length > 0
            ? await models.MarkupTimeInterval.findAll({ where: { markup_id: markupIds } })
            : [];

        const intervalsByMarkup = {};
        for (const interval of intervals) {
            if (!intervalsByMarkup[interval.markup_id]) intervalsByMarkup[interval.markup_id] = [];
            intervalsByMarkup[interval.markup_id].push(interval);
        }

        const activeCount = markups.filter(m => m.deleted_at == null).length;
        const deletedCount = markups.length - activeCount;

        const categoryColors = { intro: '#6366f1', sponsor: '#f59e0b', self_promotion: '#ec4899', credits: '#10b981' };
        const token = req.query.verifyBearerToken;

        const rows = markups.map(markup => {
            const catName = markup.category?.category || '?';
            const color = categoryColors[catName] || '#64748b';
            const createdAt = markup.createdAt ? new Date(markup.createdAt).toLocaleString('ru-RU') : '—';
            const deletedAt = markup.deleted_at ? new Date(markup.deleted_at).toLocaleString('ru-RU') : null;
            const markupIntervals = intervalsByMarkup[markup.id] || [];

            const videoCell = markup.video
                ? `<a href="/admin/video/${markup.video.id}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank">${escapeHtml(markup.video.native_id || markup.video.id)}</a>`
                : '<span class="muted">—</span>';

            const intervalRows = markupIntervals.map(i => `
            <tr class="interval-row" data-markup-id="${markup.id}">
                <td class="indent">&#x21B3;</td>
                <td colspan="2" class="muted"><span class="interval-val" data-start="${i.start}" data-end="${i.end}"></span></td>
                <td colspan="4"></td>
            </tr>`).join('');

            return `
        <tbody data-markup-id="${markup.id}">
            <tr class="${deletedAt ? 'markup-deleted' : 'markup-active'}">
                <td><span class="badge" style="background:${color}">${catName}</span></td>
                <td class="num">${markup.id}</td>
                <td>${videoCell}</td>
                <td class="muted">${markupIntervals.length} interval${markupIntervals.length !== 1 ? 's' : ''}</td>
                <td class="muted">${createdAt}</td>
                <td class="muted">${deletedAt ? `<span class="deleted-label">deleted ${deletedAt}</span>` : '—'}</td>
                <td>${deletedAt ? '' : `<button class="delete-btn" onclick="deleteMarkup(this, ${markup.id})">Delete</button>`}</td>
            </tr>
            ${intervalRows}
        </tbody>`;
        }).join('');

        const bannedLabel = user.banned_at
            ? `<span style="color:#fca5a5">banned ${formatDate(user.banned_at)}</span>`
            : '<span style="color:#86efac">not banned</span>';

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User ${user.prv_user_id ?? `#${user.id}`}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
        h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
        .meta { color: #94a3b8; font-size: 0.85rem; margin-bottom: 28px; }
        .meta span { margin-right: 16px; }
        table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; }
        thead tr { background: #0f172a; }
        th { text-align: left; padding: 10px 14px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; font-weight: 600; }
        td { padding: 10px 14px; font-size: 0.875rem; vertical-align: middle; border-top: 1px solid #0f172a; }
        td.num { font-variant-numeric: tabular-nums; }
        .markup-active td { background: #1e293b; }
        .markup-deleted td { background: #1e293b; opacity: 0.5; }
        .interval-row td { background: #162032; }
        .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: #fff; letter-spacing: 0.03em; }
        .indent { color: #475569; width: 24px; text-align: center; }
        .muted { color: #64748b; font-size: 0.8rem; }
        .deleted-label { color: #f87171; }
        a { color: #93c5fd; text-decoration: none; }
        a:hover { text-decoration: underline; }
        code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.78rem; background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #93c5fd; }
        .delete-btn { background: #7f1d1d; border: none; color: #fca5a5; font-size: 0.75rem; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
        .delete-btn:hover { background: #991b1b; }
        .delete-btn:disabled { opacity: 0.5; cursor: default; }
        .toggle-time-btn { background: #0f172a; border: 1px solid #334155; color: #64748b; font-size: 0.7rem; padding: 2px 7px; border-radius: 4px; cursor: pointer; margin-left: 6px; vertical-align: middle; font-weight: 400; text-transform: none; letter-spacing: 0; }
        .toggle-time-btn.active { background: #0f3460; border-color: #2563eb; color: #7dd3fc; }
        .empty { background: #1e293b; border-radius: 10px; padding: 20px; color: #94a3b8; font-size: 0.9rem; }
    </style>
</head>
<body>
    <h1>User <code style="font-size:1.1rem">${user.prv_user_id != null ? escapeHtml(user.prv_user_id) : `#${user.id}`}</code></h1>
    <div class="meta">
        <span>Internal id: ${user.id}</span>
        <span>prv_user_id: ${user.prv_user_id != null ? escapeHtml(user.prv_user_id) : '—'}</span>
        <span>Rating: ${user.rating}</span>
        <span>Status: ${bannedLabel}</span>
        <span>Time saved: ${user.time_saved ?? 0}</span>
        <span>Markups: ${markups.length} (${activeCount} active, ${deletedCount} deleted)</span>
    </div>
    <script>
        const AUTH_TOKEN = ${JSON.stringify(token).replace(/</g, '\\u003c')};
        let useInt = false;
        function fmt(s) {
            if (useInt) return s;
            const m = Math.floor(s / 60).toString().padStart(2, '0');
            const sec = (s % 60).toString().padStart(2, '0');
            return m + ':' + sec;
        }
        function renderIntervals() {
            document.querySelectorAll('.interval-val').forEach(el => {
                el.textContent = fmt(+el.dataset.start) + ' - ' + fmt(+el.dataset.end);
            });
        }
        function toggleTimeFormat(btn) {
            useInt = !useInt;
            btn.classList.toggle('active', useInt);
            renderIntervals();
        }
        document.addEventListener('DOMContentLoaded', renderIntervals);
        async function deleteMarkup(btn, id) {
            if (!confirm('Delete markup ' + id + '?')) return;
            btn.disabled = true;
            btn.textContent = '...';
            const res = await fetch('/admin/markups/' + id + '/delete?verifyBearerToken=' + encodeURIComponent(AUTH_TOKEN));
            if (res.ok) {
                const tbody = btn.closest('tbody');
                tbody.querySelectorAll('tr').forEach(r => r.style.opacity = '0.4');
                btn.closest('td').innerHTML = '<span class="deleted-label">deleted</span>';
            } else {
                btn.disabled = false;
                btn.textContent = 'Delete';
                alert('Error: ' + res.status);
            }
        }
    </script>

    ${markups.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th>Category</th>
                <th>Markup id</th>
                <th>Video</th>
                <th>Interval <button class="toggle-time-btn" onclick="toggleTimeFormat(this)">&#x1F552; Time</button></th>
                <th>Created at</th>
                <th>Deleted at</th>
                <th>Actions</th>
            </tr>
        </thead>
        ${rows}
    </table>` : '<div class="empty">No markups found.</div>'}
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    }));

    return router;
};
