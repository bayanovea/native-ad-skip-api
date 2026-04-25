const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const db = require('../db');
const handler = require('../middleware/handler');
const markupRepository = require('../repository/markup');

router.get('/admin/video/:video_id', handler(async (req, res) => {
    if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
        res.status(401).send('Unauthorized');
        return;
    }
    const videoId = req.params.video_id;

    const video = await db.Video.findOne({
        where: isNaN(videoId) ? { native_id: videoId } : { id: videoId }
    });

    if (!video) {
        res.status(404).send('Video not found');
        return;
    }

    const [videoCalculated, markups, categories] = await Promise.all([
        db.VideoCalculated.findOne({ where: { video_id: video.id } }),
        db.Markup.findAll({
            where: { video_id: video.id, deleted_at: null },
            include: [
                { model: db.MarkupCategory, as: 'category' },
                { model: db.User, as: 'user' }
            ],
            order: [['id', 'ASC']]
        }),
        db.MarkupCategory.findAll()
    ]);

    const categoryById = {};
    for (const cat of categories) {
        categoryById[cat.id] = cat.category;
    }

    const markupIds = markups.map(m => m.id);
    const intervals = markupIds.length > 0
        ? await db.MarkupTimeInterval.findAll({
            where: { markup_id: markupIds, deleted_at: null }
        })
        : [];

    const intervalsByMarkup = {};
    for (const interval of intervals) {
        if (!intervalsByMarkup[interval.markup_id]) {
            intervalsByMarkup[interval.markup_id] = [];
        }
        intervalsByMarkup[interval.markup_id].push(interval);
    }

    const calculatedSegments = videoCalculated ? videoCalculated.data : [];

    // Group markups by (category_id, startRounded) to match calculated segments
    const markupsByBucket = {};
    for (const markup of markups) {
        const markupIntervals = intervalsByMarkup[markup.id] || [];
        for (const interval of markupIntervals) {
            const startRounded = Math.floor(interval.start) - (Math.floor(interval.start) % 3);
            const key = `${markup.category_id}_${startRounded}`;
            if (!markupsByBucket[key]) markupsByBucket[key] = [];
            // Add markup once per bucket (multiple intervals may share the same bucket)
            if (!markupsByBucket[key].find(m => m.id === markup.id)) {
                markupsByBucket[key].push(markup);
            }
        }
    }

    const categoryColors = {
        intro: '#6366f1',
        sponsor: '#f59e0b',
        self_promotion: '#ec4899',
        credits: '#10b981',
    };

    const segmentRows = calculatedSegments.map(seg => {
        const startRounded = Math.floor(seg.start) - (Math.floor(seg.start) % 3);
        const key = `${seg.category_id}_${startRounded}`;
        const bucketMarkups = markupsByBucket[key] || [];
        const categoryName = categoryById[seg.category_id] || seg.category_id;
        const color = categoryColors[categoryName] || '#64748b';

        const markupRows = bucketMarkups.map(markup => {
            const catName = markup.category?.category || categoryById[markup.category_id] || '?';
            const createdAt = markup.createdAt ? new Date(markup.createdAt).toLocaleString('ru-RU') : '—';
            const markupIntervals = intervalsByMarkup[markup.id] || [];
            const intervalStr = markupIntervals.length
                ? markupIntervals.map(i => `<span class="interval-val" data-start="${i.start}" data-end="${i.end}" data-seg-end="${seg.end}"></span>`).join('<br>')
                : '—';
            return `
            <tr class="markup-row">
                <td class="indent" colspan="2">&#x21B3;</td>
                <td class="muted">${intervalStr}</td>
                <td>${markup.user?.prv_user_id != null ? `<a class="user-link" href="/admin/video/${video.id}/user/${markup.user.prv_user_id}?verifyBearerToken=${req.query.verifyBearerToken}" target="_blank">&#128100; ${markup.user.prv_user_id}</a>` : '—'}</td>
                <td class="muted">${createdAt}</td>
                <td><button class="delete-btn" onclick="deleteMarkup(this, ${markup.id})">Delete</button></td>
            </tr>`;
        }).join('');

        return `
        <tbody>
            <tr class="segment-row" style="border-left: 4px solid ${color}">
                <td colspan="2"><button class="toggle-btn" onclick="toggleSegment(this)">&#x25BC;</button> <strong><span class="interval-val" data-start="${seg.start}" data-end="${seg.end}"></span></strong> &nbsp;<span class="badge" style="background:${color}">${categoryName}</span></td>
                <td colspan="4" class="muted">${bucketMarkups.length} markup${bucketMarkups.length !== 1 ? 's' : ''}</td>
            </tr>
            ${markupRows}
        </tbody>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video ${videoId}</title>
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
        .toggle-btn { background: none; border: none; color: #64748b; cursor: pointer; font-size: 0.7rem; padding: 0 4px 0 0; line-height: 1; vertical-align: middle; }
        .toggle-btn:hover { color: #e2e8f0; }
    </style>
</head>
<body>
    <h1>Video: ${videoId}</h1>
    <div class="meta">
        <span>ID: ${video.id}</span>
        ${video.duration ? `<span>Duration: ${video.duration}s</span>` : ''}
        <span>Calculated segments: ${calculatedSegments.length}</span>
    </div>

    ${!videoCalculated ? '<div class="no-calc">No calculated data for this video yet.</div>' : ''}

    ${calculatedSegments.length > 0 ? `
    <table>
        <thead>
            <tr>
                <th colspan="2">Final interval</th>
                <th>Interval <button class="toggle-time-btn" onclick="toggleTimeFormat(this)">&#x1F552; Time</button></th>
                <th>User id</th>
                <th>Created at</th>
                <th>Actions</th>
            </tr>
        </thead>
        ${segmentRows}
    </table>` : '<div class="no-calc">No segments found.</div>'}
<script>
    const AUTH_TOKEN = '${req.query.verifyBearerToken}';
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
                const r = Math.round(239 + (255 - 239) * 0);
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
        const rows = tbody.querySelectorAll('.markup-row');
        const isOpen = !rows.length || rows[0].style.display !== 'none';
        rows.forEach(r => r.style.display = isOpen ? 'none' : '');
        btn.innerHTML = isOpen ? '&#x25B6;' : '&#x25BC;';
    }
    async function deleteMarkup(btn, id) {
        if (!confirm('Delete markup ' + id + '?')) return;
        btn.disabled = true;
        btn.textContent = '...';
        const res = await fetch('/admin/markups/' + id + '/delete?verifyBearerToken=' + AUTH_TOKEN);
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

    const [video, user] = await Promise.all([
        db.Video.findOne({ where: isNaN(videoId) ? { native_id: videoId } : { id: videoId } }),
        db.User.findOne({ where: { prv_user_id: prvUserId } })
    ]);

    if (!video) { res.status(404).send('Video not found'); return; }
    if (!user) { res.status(404).send('User not found'); return; }

    const markups = await db.Markup.findAll({
        where: { video_id: video.id, internal_user_id: user.id },
        include: [{ model: db.MarkupCategory, as: 'category' }],
        order: [['id', 'ASC']]
    });

    const markupIds = markups.map(m => m.id);
    const intervals = markupIds.length > 0
        ? await db.MarkupTimeInterval.findAll({ where: { markup_id: markupIds } })
        : [];

    const intervalsByMarkup = {};
    for (const interval of intervals) {
        if (!intervalsByMarkup[interval.markup_id]) intervalsByMarkup[interval.markup_id] = [];
        intervalsByMarkup[interval.markup_id].push(interval);
    }

    const categoryColors = {
        intro: '#6366f1',
        sponsor: '#f59e0b',
        self_promotion: '#ec4899',
        credits: '#10b981',
    };

    const rows = markups.map(markup => {
        const catName = markup.category?.category || '?';
        const color = categoryColors[catName] || '#64748b';
        const createdAt = markup.createdAt ? new Date(markup.createdAt).toLocaleString('ru-RU') : '—';
        const deletedAt = markup.deleted_at ? new Date(markup.deleted_at).toLocaleString('ru-RU') : null;
        const markupIntervals = intervalsByMarkup[markup.id] || [];

        const intervalRows = markupIntervals.map(i => `
            <tr class="interval-row">
                <td class="indent">&#x21B3;</td>
                <td class="muted"><span class="interval-val" data-start="${i.start}" data-end="${i.end}"></span></td>
                <td colspan="3"></td>
            </tr>`).join('');

        return `
        <tbody data-markup-id="${markup.id}">
            <tr class="${deletedAt ? 'markup-deleted' : 'markup-active'}">
                <td><span class="badge" style="background:${color}">${catName}</span></td>
                <td class="muted">${markupIntervals.length} interval${markupIntervals.length !== 1 ? 's' : ''}</td>
                <td class="muted">${createdAt}</td>
                <td class="muted">${deletedAt ? `<span class="deleted-label">deleted ${deletedAt}</span>` : '—'}</td>
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
    <title>User ${prvUserId} — Video ${videoId}</title>
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
        .empty { text-align: center; padding: 48px; color: #475569; }
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
    <h1>User <code style="font-size:1.1rem">${prvUserId}</code> — <a href="/admin/video/${videoId}?verifyBearerToken=${req.query.verifyBearerToken}">Video ${videoId}</a></h1>
    <div class="meta">
        <span>Video DB id: ${video.id}</span>
        ${video.duration ? `<span>Duration: ${video.duration}s</span>` : ''}
        <span>Markups: ${markups.length}</span>
        <span>Rating: ${user.rating}</span>
    </div>

    <script>
        const AUTH_TOKEN = '${req.query.verifyBearerToken}';
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
            const res = await fetch('/admin/markups/' + id + '/delete?verifyBearerToken=' + AUTH_TOKEN);
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
    if (!markup) {
        res.status(404).send('Not found');
        return;
    }

    await markupRepository.softDeleteByIds([markupId], 'admin', 1);

    const videoMarkups = await markupRepository.findAll({ where: { video_id: markup.video_id } });
    if (videoMarkups.length > 0) {
        await db.Markup.update({ is_new: true }, { where: { video_id: markup.video_id } });
    } else {
        await db.VideoCalculated.destroy({ where: { video_id: markup.video_id } });
    }

    res.status(200).send('Deleted');
}));

module.exports = router;
