const express = require('express');
const handler = require('../../middleware/handler');
const { CATEGORY_COLORS, escapeHtml, urlToken } = require('../../lib/admin-html');

// `videoId` is matched against native_id, which any client sets through
// POST /markup, so every value goes through escapeHtml (URL parts through
// encodeURIComponent first) and the token in <script> through scriptString():
// a JS string literal with `<` escaped so it can never close the script
// element (same as admin-moderation.js).
function scriptString(value) {
    return JSON.stringify(String(value)).replace(/</g, '\\u003c');
}

module.exports = function createAdminRoutes(models, { markupRepository }) {
    const router = express.Router();

    router.get('/admin/video/:video_id', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }
        const videoId = req.params.video_id;
        const token = req.query.verifyBearerToken;

        const video = await models.Video.findOne({
            where: isNaN(videoId) ? { native_id: videoId } : { id: videoId },
        });
        if (!video) { res.status(404).send('Video not found'); return; }

        const calculatedSegments = await models.CalculatedSegment.findAll({
            where: { video_id: video.id },
            include: [
                { model: models.MarkupCategory, as: 'category' },
                { model: models.CalculatedSegmentMarkup, as: 'segment_markups' },
            ],
            order: [['start', 'ASC']],
        });

        const markupIds = [...new Set(calculatedSegments.flatMap(seg => seg.segment_markups.map(sm => sm.markup_id)))];

        const [markups, intervals] = await Promise.all([
            markupIds.length > 0
                ? models.Markup.findAll({
                    where: { id: markupIds, deleted_at: null },
                    include: [{ model: models.User, as: 'user' }],
                })
                : [],
            markupIds.length > 0
                ? models.MarkupTimeInterval.findAll({ where: { markup_id: markupIds, deleted_at: null } })
                : [],
        ]);

        const markupById = {};
        for (const markup of markups) markupById[markup.id] = markup;

        const intervalsByMarkup = {};
        for (const interval of intervals) {
            if (!intervalsByMarkup[interval.markup_id]) intervalsByMarkup[interval.markup_id] = [];
            intervalsByMarkup[interval.markup_id].push(interval);
        }

        const segmentRows = calculatedSegments.map(seg => {
            const segMarkups = seg.segment_markups
                .map(sm => markupById[sm.markup_id])
                .filter(m => m != null);
            if (segMarkups.length === 0) return '';

            const categoryName = seg.category?.category || seg.category_id;
            const color = CATEGORY_COLORS[categoryName] || '#64748b';

            const intervalGroups = {};
            for (const markup of segMarkups) {
                const mIntervals = intervalsByMarkup[markup.id] || [];
                if (mIntervals.length === 0) continue;
                const interval = mIntervals.find(i => i.start >= seg.start && i.start < seg.end) || mIntervals[0];
                const gKey = `${interval.start}_${interval.end}`;
                if (!intervalGroups[gKey]) intervalGroups[gKey] = { start: interval.start, end: interval.end, items: [] };
                intervalGroups[gKey].items.push(markup);
            }
            const markupRows = Object.values(intervalGroups)
                .sort((a, b) => a.start - b.start)
                .map((group, gIdx) => {
                    const groupId = `${seg.id}_${gIdx}`;
                    const subRows = group.items.map(markup => {
                        const createdAt = markup.createdAt ? new Date(markup.createdAt).toLocaleString('ru-RU') : '—';
                        const userLink = markup.user?.prv_user_id != null
                            ? `<a class="user-link" href="/admin/video/${video.id}/user/${escapeHtml(encodeURIComponent(markup.user.prv_user_id))}?verifyBearerToken=${escapeHtml(urlToken(token))}" target="_blank">&#128100; ${escapeHtml(markup.user.prv_user_id)}</a>`
                            : '—';
                        return `
                <tr class="markup-row" data-group="${groupId}" style="display:none">
                    <td colspan="4"></td>
                    <td>${userLink}</td>
                    <td class="muted">${escapeHtml(createdAt)}</td>
                    <td><button class="delete-btn" onclick="deleteMarkup(this, ${markup.id})">Delete</button></td>
                </tr>`;
                    }).join('');
                    return `
            <tr class="interval-group-row">
                <td colspan="2"></td>
                <td class="muted"><span class="interval-val" data-start="${escapeHtml(group.start)}" data-end="${escapeHtml(group.end)}" data-seg-end="${escapeHtml(seg.end)}"></span></td>
                <td class="muted">${group.items.length}</td>
                <td><button class="toggle-group-btn" onclick="toggleGroup(this, '${groupId}')">Show</button></td>
                <td><button class="toggle-group-btn" onclick="toggleGroup(this, '${groupId}')">Show</button></td>
                <td><button class="toggle-group-btn" onclick="toggleGroup(this, '${groupId}')">Show</button></td>
            </tr>
            ${subRows}`;
                }).join('');

            return `
        <tbody>
            <tr class="segment-row" style="border-left: 4px solid ${color}">
                <td colspan="2"><button class="toggle-btn" onclick="toggleSegment(this)">Hide</button> <strong><span class="interval-val" data-start="${escapeHtml(seg.start)}" data-end="${escapeHtml(seg.end)}"></span></strong> &nbsp;<span class="badge" style="background:${color}">${escapeHtml(categoryName)}</span></td>
                <td colspan="5" class="muted">${segMarkups.length} markup${segMarkups.length !== 1 ? 's' : ''}</td>
            </tr>
            ${markupRows}
        </tbody>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video ${escapeHtml(videoId)}</title>
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
        .segment-row td { background: #1e293b; padding-top: 14px; padding-bottom: 14px; }
        .markup-row td { background: #162032; }
        .markup-row:last-child td { padding-bottom: 14px; }
        .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: #fff; letter-spacing: 0.03em; }
        .time { font-variant-numeric: tabular-nums; font-weight: 500; }
        .indent { color: #475569; width: 24px; text-align: center; }
        .muted { color: #64748b; font-size: 0.8rem; }
        code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.78rem; background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #93c5fd; }
        .empty { text-align: center; padding: 48px; color: #475569; }
        .no-calc { background: #1e293b; border-radius: 10px; padding: 20px; color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px; }
        a { color: #93c5fd; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .user-link { display: inline-block; background: #1e3a5f; color: #7dd3fc; font-size: 0.8rem; font-weight: 600; padding: 2px 8px; border-radius: 6px; border: 1px solid #2563eb; }
        .user-link:hover { background: #1d4ed8; text-decoration: none; }
        .delete-btn { background: #7f1d1d; border: none; color: #fca5a5; font-size: 0.75rem; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
        .delete-btn:hover { background: #991b1b; }
        .delete-btn:disabled { opacity: 0.5; cursor: default; }
        .toggle-time-btn { background: #0f172a; border: 1px solid #334155; color: #64748b; font-size: 0.7rem; padding: 2px 7px; border-radius: 4px; cursor: pointer; margin-left: 6px; vertical-align: middle; font-weight: 400; text-transform: none; letter-spacing: 0; }
        .toggle-time-btn.active { background: #0f3460; border-color: #2563eb; color: #7dd3fc; }
        .interval-group-row td { background: #162032; }
        .markup-row td { background: #0f1a2a; }
        .toggle-group-btn { background: none; border: none; color: #475569; cursor: pointer; font-size: 0.65rem; padding: 0 4px; vertical-align: middle; }
        .toggle-group-btn:hover { color: #e2e8f0; }
        .toggle-btn { background: none; border: none; color: #64748b; cursor: pointer; font-size: 0.7rem; padding: 0 4px 0 0; line-height: 1; vertical-align: middle; }
        .toggle-btn:hover { color: #e2e8f0; }
    </style>
</head>
<body>
    <h1>Video: ${escapeHtml(videoId)}</h1>
    <div class="meta">
        <span>ID: ${video.id}</span>
        ${video.duration ? `<span>Duration: ${escapeHtml(video.duration)}s</span>` : ''}
        <span>Calculated segments: ${calculatedSegments.length}</span>
    </div>

    ${calculatedSegments.length === 0 ? '<div class="no-calc">No calculated data for this video yet.</div>' : ''}

    ${calculatedSegments.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th colspan="2">Final interval</th>
                <th>Interval <button class="toggle-time-btn" onclick="toggleTimeFormat(this)">&#x1F552; Time</button></th>
                <th>Count</th>
                <th>User id</th>
                <th>Created at</th>
                <th>Actions</th>
            </tr>
        </thead>
        ${segmentRows}
    </table>` : '<div class="no-calc">No segments found.</div>'}
<script>
    const AUTH_TOKEN = ${scriptString(token)};
    let useInt = false;
    function fmt(s) {
        if (useInt) return s;
        const m = Math.floor(s / 60).toString().padStart(2, '0');
        const sec = (s % 60).toString().padStart(2, '0');
        return m + ':' + sec;
    }
    function renderIntervals() {
        document.querySelectorAll('.interval-val').forEach(el => {
            const start = +el.dataset.start;
            const end = +el.dataset.end;
            const segEnd = el.dataset.segEnd !== undefined ? +el.dataset.segEnd : null;
            const endStr = fmt(end);
            if (segEnd !== null && Math.abs(end - segEnd) > 3) {
                const alpha = Math.min(1, (Math.abs(end - segEnd) - 3) / 20);
                el.innerHTML = fmt(start) + ' - <span style="color:rgba(248,113,113,' + (0.6 + alpha * 0.4).toFixed(2) + ')">' + endStr + '</span>';
            } else {
                el.textContent = fmt(start) + ' - ' + endStr;
            }
        });
    }
    function toggleTimeFormat(btn) {
        useInt = !useInt;
        btn.classList.toggle('active', useInt);
        renderIntervals();
    }
    renderIntervals();
    function toggleSegment(btn) {
        const tbody = btn.closest('tbody');
        const rows = tbody.querySelectorAll('.interval-group-row');
        const isOpen = !rows.length || rows[0].style.display !== 'none';
        rows.forEach(r => r.style.display = isOpen ? 'none' : '');
        if (isOpen) {
            tbody.querySelectorAll('.markup-row').forEach(r => r.style.display = 'none');
            tbody.querySelectorAll('.toggle-group-btn').forEach(b => b.textContent = 'Show');
        }
        btn.textContent = isOpen ? 'Show' : 'Hide';
    }
    function toggleGroup(btn, groupId) {
        const rows = document.querySelectorAll('[data-group="' + groupId + '"]');
        const isOpen = rows.length > 0 && rows[0].style.display !== 'none';
        rows.forEach(r => r.style.display = isOpen ? 'none' : '');
        btn.closest('tr').querySelectorAll('.toggle-group-btn').forEach(b => b.textContent = isOpen ? 'Show' : 'Hide');
    }
    async function deleteMarkup(btn, id) {
        if (!confirm('Delete markup ' + id + '?')) return;
        btn.disabled = true;
        btn.textContent = '...';
        const res = await fetch('/admin/markups/' + id + '/delete?verifyBearerToken=' + encodeURIComponent(AUTH_TOKEN));
        if (res.ok) {
            const row = btn.closest('tr');
            row.style.opacity = '0.4';
            btn.closest('td').innerHTML = '<span style="color:#f87171;font-size:0.75rem">deleted</span>';
        } else {
            btn.disabled = false;
            btn.textContent = 'Delete';
            alert('Error: ' + res.status);
        }
    }
</script>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    }));

    router.get('/admin/video/:video_id/user/:prv_user_id', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        const videoId = req.params.video_id;
        const prvUserId = parseInt(req.params.prv_user_id);
        const token = req.query.verifyBearerToken;

        const [video, user] = await Promise.all([
            models.Video.findOne({ where: isNaN(videoId) ? { native_id: videoId } : { id: videoId } }),
            models.User.findOne({ where: { prv_user_id: prvUserId } }),
        ]);

        if (!video) { res.status(404).send('Video not found'); return; }
        if (!user) { res.status(404).send('User not found'); return; }

        const markups = await models.Markup.findAll({
            where: { video_id: video.id, internal_user_id: user.id },
            include: [{ model: models.MarkupCategory, as: 'category' }],
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

        const rows = markups.map(markup => {
            const catName = markup.category?.category || '?';
            const color = CATEGORY_COLORS[catName] || '#64748b';
            const createdAt = markup.createdAt ? new Date(markup.createdAt).toLocaleString('ru-RU') : '—';
            const deletedAt = markup.deleted_at ? new Date(markup.deleted_at).toLocaleString('ru-RU') : null;
            const markupIntervals = intervalsByMarkup[markup.id] || [];

            const intervalRows = markupIntervals.map(i => `
            <tr class="interval-row">
                <td class="indent">&#x21B3;</td>
                <td class="muted"><span class="interval-val" data-start="${escapeHtml(i.start)}" data-end="${escapeHtml(i.end)}"></span></td>
                <td colspan="3"></td>
            </tr>`).join('');

            return `
        <tbody data-markup-id="${markup.id}">
            <tr class="${deletedAt ? 'markup-deleted' : 'markup-active'}">
                <td><span class="badge" style="background:${color}">${escapeHtml(catName)}</span></td>
                <td class="muted">${markupIntervals.length} interval${markupIntervals.length !== 1 ? 's' : ''}</td>
                <td class="muted">${escapeHtml(createdAt)}</td>
                <td class="muted">${deletedAt ? `<span class="deleted-label">deleted ${escapeHtml(deletedAt)}</span>` : '—'}</td>
                <td>${deletedAt ? '' : `<button class="delete-btn" onclick="deleteMarkup(this, ${markup.id})">Delete</button>`}</td>
            </tr>
            ${intervalRows}
        </tbody>`;
        }).join('');

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>User ${escapeHtml(prvUserId)} — Video ${escapeHtml(videoId)}</title>
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
        .markup-active td { background: #1e293b; }
        .markup-deleted td { background: #1e293b; opacity: 0.5; }
        .interval-row td { background: #162032; }
        .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; color: #fff; letter-spacing: 0.03em; }
        .indent { color: #475569; width: 24px; text-align: center; }
        .muted { color: #64748b; font-size: 0.8rem; }
        .deleted-label { color: #f87171; }
        a { color: #93c5fd; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .delete-btn { background: #7f1d1d; border: none; color: #fca5a5; font-size: 0.75rem; padding: 3px 10px; border-radius: 4px; cursor: pointer; }
        .delete-btn:hover { background: #991b1b; }
        .delete-btn:disabled { opacity: 0.5; cursor: default; }
        .toggle-time-btn { background: #0f172a; border: 1px solid #334155; color: #64748b; font-size: 0.7rem; padding: 2px 7px; border-radius: 4px; cursor: pointer; margin-left: 6px; vertical-align: middle; font-weight: 400; text-transform: none; letter-spacing: 0; }
        .toggle-time-btn.active { background: #0f3460; border-color: #2563eb; color: #7dd3fc; }
    </style>
</head>
<body>
    <h1>User <code style="font-size:1.1rem">${escapeHtml(prvUserId)}</code> — <a href="/admin/video/${escapeHtml(encodeURIComponent(videoId))}?verifyBearerToken=${escapeHtml(urlToken(token))}">Video ${escapeHtml(videoId)}</a></h1>
    <div class="meta">
        <span>Video DB id: ${video.id}</span>
        ${video.duration ? `<span>Duration: ${escapeHtml(video.duration)}s</span>` : ''}
        <span>Markups: ${markups.length}</span>
        <span>Rating: ${escapeHtml(user.rating)}</span>
    </div>
    <script>
        const AUTH_TOKEN = ${scriptString(token)};
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
                <th>Interval <button class="toggle-time-btn" onclick="toggleTimeFormat(this)">&#x1F552; Time</button></th>
                <th>Created at</th>
                <th>Deleted at</th>
                <th>Actions</th>
            </tr>
        </thead>
        ${rows}
    </table>` : '<div style="background:#1e293b;border-radius:10px;padding:20px;color:#94a3b8">No markups found.</div>'}
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    }));

    router.get('/admin/markups/:id/delete', handler(async (req, res) => {
        if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
            res.status(401).send('Unauthorized');
            return;
        }

        const markupId = req.params.id;
        const markup = await markupRepository.findByPk(markupId);
        if (!markup) { res.status(404).send('Not found'); return; }

        // Wrap the soft-delete and the follow-up bookkeeping in one
        // transaction so a crash mid-way can't leave the calculator with a
        // half-deleted markup and a stale VideoCalculated row. This endpoint
        // is hit from the legacy /admin/video page AND the new
        // /admin/user view's delete button, so both surfaces benefit.
        const sequelize = models.Markup.sequelize;
        await sequelize.transaction(async (transaction) => {
            await markupRepository.softDeleteByIds([markupId], 'admin', 1, { transaction });

            const videoMarkups = await markupRepository.findAll({
                where: { video_id: markup.video_id },
                transaction,
            });
            if (videoMarkups.length > 0) {
                // Filter `deleted_at IS NULL` so we don't flip the just-
                // soft-deleted target back to is_new=true — otherwise the
                // calculator would resurrect it on its next pass.
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
        });

        res.status(200).send('Deleted');
    }));

    return router;
};
