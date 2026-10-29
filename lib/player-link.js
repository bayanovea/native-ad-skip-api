'use strict';

// provider.LinkAt in Go: the prv player link at `seconds` (callers pass start − 2, as every sheet link does).
function linkAt(nativeId, seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const t = h > 0 ? `${h}h${m}m${sec}s` : m > 0 ? `${m}m${sec}s` : `${sec}s`;
    return `https://example.invalid/video${nativeId}?t=${t}`;
}

module.exports = { linkAt };
