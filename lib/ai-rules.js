'use strict';

// AI_MIN_SEGMENT_SECONDS: an AI segment shorter than this is kept in `hidden`, never served. ai/pipeline reads the
// same variable; a change takes a restart and `ai regate`.
function parseMinSegmentSeconds(value) {
    if (value === undefined || value === '') return 5;
    if (!/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error(`AI_MIN_SEGMENT_SECONDS must be an integer of at least 1, got "${value}"`);
    }
    return Number(value);
}

const MIN_SEGMENT_SECONDS = parseMinSegmentSeconds(process.env.AI_MIN_SEGMENT_SECONDS);

module.exports = { MIN_SEGMENT_SECONDS, parseMinSegmentSeconds };
