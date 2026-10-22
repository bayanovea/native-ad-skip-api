'use strict';

// Read once at boot: the kill switch is an env change plus a restart.
const AI_FIRST = process.env.AI_FIRST === 'on';

// Lookup outcomes of findVideoForReadWithOutcome under which GET /video-calculated may serve
// the AI row: the player's duration fits that videos row within ±2 s. On `mismatch` /
// `no_duration` the row may be another cut's, so the human path is served.
const AI_LOOKUP_OUTCOMES = new Set(['match', 'backfilled']);

// AI_FIRST on, the row not withdrawn and something published (non-empty `data`).
function servesAi(row) {
    return AI_FIRST && !!row && row.withdrawn_at == null && Array.isArray(row.data) && row.data.length > 0;
}

/**
 * The prv_ai_video_calculateds row served for the videos row instead of its
 * video_calculateds, or null (see servesAi).
 */
async function findAiCalculated(models, videoId, { transaction } = {}) {
    if (!AI_FIRST) return null;
    const row = await models.AiVideoCalculated.findOne({ where: { video_id: videoId, withdrawn_at: null }, transaction });
    return servesAi(row) ? row : null;
}

/**
 * The video's AI row in any state (or null), held FOR UPDATE in `transaction`. The vote handlers
 * lock it after VideoCalculated and recompute its entry on every vote, so its ratings stay right
 * through a withdraw / restore or an AI_FIRST flip.
 */
async function lockAiCalculated(models, videoId, { transaction }) {
    return models.AiVideoCalculated.findOne({ where: { video_id: videoId }, lock: transaction.LOCK.UPDATE, transaction });
}

module.exports = { findAiCalculated, lockAiCalculated, servesAi, AI_LOOKUP_OUTCOMES };
