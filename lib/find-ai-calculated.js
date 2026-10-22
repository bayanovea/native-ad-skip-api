'use strict';

// Read once at boot: the kill switch is an env change plus a restart.
const AI_FIRST = process.env.AI_FIRST === 'on';

/**
 * The prv_ai_video_calculateds row served for the videos row instead of its
 * video_calculateds, or null: AI_FIRST off, no row, withdrawn, or nothing
 * published (empty `data`). Pass `lock` (with `transaction`) to hold the row
 * FOR UPDATE, as the vote handler does.
 */
async function findAiCalculated(models, videoId, { transaction, lock } = {}) {
    if (!AI_FIRST) return null;
    const row = await models.AiVideoCalculated.findOne({
        where: { video_id: videoId, withdrawn_at: null },
        transaction,
        lock,
    });
    return row && Array.isArray(row.data) && row.data.length > 0 ? row : null;
}

module.exports = { findAiCalculated };
