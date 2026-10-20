'use strict';

// A reviewer's name is also their code (URLs, verdict rows), so it is stored
// exactly as this returns it.
const REVIEWER_MAX = 64;
const NAME_CHARS = /^[\p{L}\p{M}\p{Nd} ._-]+$/u;

// The cleaned name, or null when it breaks the rules: trimmed, inner space runs
// collapsed, 1–64 characters of letters (any script), digits, space, `.`, `_`, `-`.
// NFC first, so the same name typed with combining marks (й as и + ◌̆) is one code.
function validReviewerName(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.normalize('NFC').trim().replace(/ {2,}/g, ' ');
    return name.length <= REVIEWER_MAX && NAME_CHARS.test(name) ? name : null;
}

module.exports = { REVIEWER_MAX, validReviewerName };
