'use strict';

// Helpers shared by the server-rendered prv admin pages (prv/routes/admin.js,
// admin-moderation.js, admin-review.js).

// Badge colour per markup category; pages fall back to '#64748b' for others.
const CATEGORY_COLORS = Object.freeze({
    intro: '#6366f1',
    sponsor: '#f59e0b',
    self_promotion: '#ec4899',
    credits: '#10b981',
});

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
// result is a no-op — callers keep both for defense-in-depth. Inline <script>
// blocks use encodeURIComponent directly at runtime; this helper covers the
// server-rendered <a href> case.
function urlToken(value) {
    if (value == null) return '';
    return encodeURIComponent(String(value));
}

// `YYYY-MM-DD HH:MM:SS` (UTC) or '—' for null / invalid dates.
function formatDate(value) {
    if (value == null) return '—';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

module.exports = { CATEGORY_COLORS, escapeHtml, urlToken, formatDate };
