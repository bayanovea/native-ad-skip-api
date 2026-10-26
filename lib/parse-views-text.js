'use strict';

// The view counter as the prv page shows it ("39,4 тыс просмотров", "1.7M views", "1 234 567 просмотров") → the
// count, or null when the string does not read as exactly one number. The gate it feeds (AI_MIN_VIEWS) is coarse,
// so abbreviated forms are fine, but a doubtful reading is null: the first parsed count switches the video off the
// requests fallback for good (prv/repository/ai.js seen), so a low misreading costs more than no reading.
const SUFFIX_EXP = { 'тыс': 3, 'млн': 6, 'млрд': 9, 'k': 3, 'm': 6, 'b': 9 };
const MAX_VIEWS = 2147483647; // INTEGER column

function parseViewsText(text) {
    if (typeof text !== 'string') return null;
    const s = text.replace(/\s+/gu, ' ').trim();
    const m = /(\d[\d .,]*?)(?=\s*(?:[^\d .,]|$))\s*(?:(\p{L}+)\.?(?!\p{L}))?/u.exec(s);
    if (!m) return null;
    const token = m[1].replace(/[ .,]+$/u, '');
    const exp = m[2] ? SUFFIX_EXP[m[2].toLowerCase()] : undefined;
    let value;
    if (exp !== undefined) {
        // Decimal with the locale's separator ("39,4 тыс", "1.7M"); the fraction may not outrun the suffix.
        const d = /^(\d+)(?:[.,](\d+))?$/u.exec(token);
        if (!d || (d[2] && d[2].length > exp)) return null;
        value = Number(d[1] + (d[2] || '').padEnd(exp, '0'));
    } else if (/^\d+$/u.test(token)) {
        value = Number(token);
    } else {
        // Thousands groups with one consistent separator ("1 234 567", "1,234,567"); "1,2" or "12,34" is a fraction, not a count.
        const g = /^\d{1,3}(?:([ .,])\d{3})(?:\1\d{3})*$/u.exec(token);
        if (!g) return null;
        value = Number(token.replace(/[ .,]/gu, ''));
    }
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_VIEWS ? value : null;
}

module.exports = { parseViewsText, MAX_VIEWS };
