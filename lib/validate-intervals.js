'use strict';

// Validator for POST /markup `data.intervals`, shared by the prv, rt and yt routes
// (body('data.intervals').custom(validateIntervals)). Every failure throws, so
// validateRequest answers 400 before anything is written.

const MAX_INTERVALS = 20;
const MAX_SECONDS = 86400;

// A finite number, or a non-blank string whose Number() is finite (older clients
// may send numeric strings). Anything else → null.
function toSeconds(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function validateIntervals(value) {
    if (!Array.isArray(value)) throw new Error('data.intervals must be an array');
    if (value.length === 0) throw new Error('data.intervals must not be empty');
    if (value.length > MAX_INTERVALS) throw new Error(`data.intervals must have at most ${MAX_INTERVALS} items`);

    value.forEach((interval, i) => {
        const at = `data.intervals[${i}]`;
        if (interval === null || typeof interval !== 'object') throw new Error(`${at} must be an object`);

        const start = toSeconds(interval.start);
        if (start === null) throw new Error(`${at}.start must be a finite number`);
        const end = toSeconds(interval.end);
        if (end === null) throw new Error(`${at}.end must be a finite number`);

        // The rounded values are what gets stored, so the rules apply to them.
        const roundedStart = Math.round(start);
        const roundedEnd = Math.round(end);
        if (roundedStart < 0) throw new Error(`${at}.start must be >= 0`);
        if (roundedEnd > MAX_SECONDS) throw new Error(`${at}.end must be <= ${MAX_SECONDS}`);
        if (roundedStart >= roundedEnd) throw new Error(`${at}.start must be less than end (after rounding)`);
    });

    return true;
}

module.exports = { validateIntervals, MAX_INTERVALS, MAX_SECONDS };
