'use strict';

// provider.LinkAt in Go: the player link at `seconds` (callers pass start − 2, as every sheet link does).
// PROVIDER_LINK_AT is the platform's URL template, read once: {id} = native id, {t} = 1h2m3s.
const TEMPLATE = process.env.PROVIDER_LINK_AT || 'https://example.invalid/video{id}?t={t}';

function linkAt(nativeId, seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const t = h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
    return TEMPLATE.replace(/\{id\}|\{t\}/g, (p) => (p === '{id}' ? String(nativeId) : t));
}

module.exports = { linkAt };
