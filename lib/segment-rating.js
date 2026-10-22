'use strict';

const { QueryTypes } = require('sequelize');

// A segment's rating is the sum of each user's latest vote ("createdAt" DESC,
// id DESC) on the exact (video_id, category_id, start, end). Same rule as
// voteRatings in calculator/calculate.go, which writes the ratings on every
// recalculation and on `calculate --recompute-ratings`.
//
// `models` is a provider's model set (prv/db, rt/db, yt/db), so the table names
// come from it.

/**
 * Lock the video's VideoCalculated row (FOR UPDATE) for the rest of the
 * transaction and return it, or null when the video has none. A recalculation
 * deletes and re-inserts the row: when the locked read waited for one, it finds
 * the old row gone, so it reads once more to get the new one.
 */
async function lockVideoCalculated(models, videoId, { transaction }) {
    const find = () => models.VideoCalculated.findOne({
        where: { video_id: videoId },
        lock: transaction.LOCK.UPDATE,
        transaction,
    });
    return (await find()) || find();
}

async function voteRating(models, { videoId, categoryId, start, end }, { transaction } = {}) {
    const [row] = await models.Vote.sequelize.query(`
        SELECT COALESCE(SUM(vote), 0)::int AS rating FROM (
            SELECT DISTINCT ON (user_id, category_id, start, "end") vote
            FROM "${models.Vote.getTableName()}"
            WHERE video_id = :videoId AND category_id = :categoryId AND start = :start AND "end" = :end
            ORDER BY user_id, category_id, start, "end", "createdAt" DESC, id DESC
        ) latest
    `, {
        replacements: { videoId, categoryId, start, end },
        type: QueryTypes.SELECT,
        transaction,
    });
    return row.rating;
}

/**
 * Recompute one segment's rating from the votes table and store it in the
 * segment row and in the matching VideoCalculated.data entry (omitted when 0).
 * The caller holds the VideoCalculated row lock (lockVideoCalculated) in
 * `transaction`. A missing segment row or JSON entry is skipped. Returns the
 * rating.
 */
async function recomputeSegmentRating(models, { videoId, categoryId, start, end }, { transaction } = {}) {
    const rating = await voteRating(models, { videoId, categoryId, start, end }, { transaction });

    await models.CalculatedSegment.update(
        { rating },
        { where: { video_id: videoId, category_id: categoryId, start, end }, transaction }
    );

    const calculatedVideo = await models.VideoCalculated.findOne({ where: { video_id: videoId }, transaction });
    const data = calculatedVideo && withRating(calculatedVideo.data, { categoryId, start, end }, rating);
    if (data) await calculatedVideo.update({ data }, { transaction });

    return rating;
}

/**
 * The same for an AI-first video: only the entry in prv_ai_video_calculateds.data
 * (there are no segment rows for AI). The caller holds that row's lock
 * (lockAiCalculated) in `transaction`.
 */
async function recomputeAiSegmentRating(models, aiRow, { categoryId, start, end }, { transaction }) {
    const rating = await voteRating(models, { videoId: aiRow.video_id, categoryId, start, end }, { transaction });
    const data = withRating(aiRow.data, { categoryId, start, end }, rating);
    if (data) await aiRow.update({ data, updated_at: aiRow.sequelize.fn('NOW') }, { transaction });
    return rating;
}

// `data` with the matching entry's rating set (omitted when 0, the default),
// or null when nothing changed.
function withRating(data, { categoryId, start, end }, rating) {
    if (!Array.isArray(data)) return null;
    let changed = false;
    const newData = data.map(item => {
        if (item.category_id !== categoryId || item.start !== start || item.end !== end) return item;
        const { rating: current, ...rest } = item;
        if (rating ? current === rating : current === undefined) return item;
        changed = true;
        return rating ? { ...rest, rating } : rest;
    });
    return changed ? newData : null;
}

module.exports = { lockVideoCalculated, recomputeSegmentRating, recomputeAiSegmentRating, voteRating };
