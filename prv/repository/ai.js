const { QueryTypes } = require('sequelize');
const { voteRating } = require('../../lib/segment-rating');

const KEEP_VERDICTS = new Set(['sponsor', 'self_promotion']);
// A prv video id (`<owner>_<id>`, owner negative for a community); anything else is never queued for `ai detect`
// (ai/pipeline/queue.go nativeIDRegex is the same pattern).
const PRV_NATIVE_ID = /^-?\d+_\d+$/;
// A keep verdict never restores a row withdrawn by `admin` (the operator's switch).
const RESTORABLE_BY = new Set(['judge', 'review']);

module.exports = function createAiRepository(models, sequelize) {
    // Every entry of the row has a keep verdict as its latest one, decided after the row was withdrawn.
    async function allKept(row, data, transaction) {
        const latest = await sequelize.query(
            `SELECT DISTINCT ON (i.start, i."end") i.start, i."end", v.verdict, v.decided_at
               FROM prv_review_items i JOIN prv_review_verdicts v ON v.item_id = i.id
              WHERE i.kind = 'ai' AND i.video_id = :videoId
              ORDER BY i.start, i."end", v.decided_at DESC, v.id DESC`,
            { replacements: { videoId: row.video_id }, type: QueryTypes.SELECT, transaction });
        return data.every(e => latest.some(l => l.start === e.start && l.end === e.end
            && KEEP_VERDICTS.has(l.verdict) && l.decided_at >= row.withdrawn_at));
    }

    return {
        // GREATEST skips NULL, so a request without `views` never lowers or clears views_max.
        async seen(nativeId, views) {
            if (!PRV_NATIVE_ID.test(nativeId)) return;
            await sequelize.query(
                `INSERT INTO prv_ai_videos (native_id, views_max, requests)
                 VALUES (:nativeId, :views, 1)
                 ON CONFLICT (native_id) DO UPDATE SET
                     views_max = GREATEST(prv_ai_videos.views_max, EXCLUDED.views_max),
                     requests = prv_ai_videos.requests + 1,
                     last_seen_at = CURRENT_TIMESTAMP`,
                { replacements: { nativeId, views: views ?? null } });
        },

        // Unpublish the video's AI row (`by`: judge | review | admin); `data` stays for the record.
        // Returns false when there is no row or it is already withdrawn. ai/judge/judge.go record mirrors both writes.
        async withdraw(videoId, by, reason, { transaction } = {}) {
            const run = async (t) => {
                const [rows] = await sequelize.query(
                    `UPDATE prv_ai_video_calculateds
                     SET withdrawn_at = NOW(), withdrawn_by = :by, withdrawn_reason = :reason, updated_at = NOW()
                     WHERE video_id = :videoId AND withdrawn_at IS NULL
                     RETURNING native_id`,
                    { replacements: { videoId, by, reason: reason ?? null }, transaction: t });
                if (!rows.length) return false;
                await sequelize.query(
                    `UPDATE prv_ai_videos SET status = 'withdrawn', updated_at = NOW() WHERE native_id = :nativeId`,
                    { replacements: { nativeId: rows[0].native_id }, transaction: t });
                return true;
            };
            return transaction ? run(transaction) : sequelize.transaction(run);
        },

        /**
         * Apply a review verdict on a kind='ai' item to its AI row (the entry with the item's bounds), under the
         * row's lock in the caller's `transaction`: not_ad / unclear remove the entry (the row is withdrawn by
         * `review` when none is left); sponsor / self_promotion keep it, or put it back, with that category. A row
         * withdrawn by judge or review is served again once every entry has a keep verdict. Idempotent; returns
         * true when the row changed.
         */
        async applyVerdict(item, verdict, { transaction }) {
            if (item.kind !== 'ai' || item.video_id == null) return false;
            const row = await models.AiVideoCalculated.findOne({
                where: { video_id: item.video_id }, lock: transaction.LOCK.UPDATE, transaction });
            if (!row) return false;
            const at = row.data.findIndex(e => e.start === item.start && e.end === item.end);
            let data = row.data;
            if (KEEP_VERDICTS.has(verdict)) {
                const category = await models.MarkupCategory.findOne({ where: { category: verdict }, transaction });
                const old = at === -1 ? { start: item.start, end: item.end, source: 'ai' } : data[at];
                if (old.category_id !== category.id) {
                    const { rating: _, ...rest } = old;
                    const rating = await voteRating(models, { videoId: row.video_id, categoryId: category.id, start: item.start, end: item.end }, { transaction });
                    const entry = { ...rest, category_id: category.id, ...(rating ? { rating } : {}) };
                    data = at === -1
                        ? [...data, entry].sort((a, b) => a.start - b.start)
                        : data.map((e, i) => (i === at ? entry : e));
                }
            } else if (at !== -1) {
                data = data.filter((_, i) => i !== at);
            }
            let changed = data !== row.data;
            if (changed) await row.update({ data, updated_at: sequelize.fn('NOW') }, { transaction });

            if (!row.withdrawn_at && data.length === 0) {
                return (await this.withdraw(row.video_id, 'review', `review: ${verdict} on ${item.batch} ${item.item_code}`, { transaction })) || changed;
            }
            if (row.withdrawn_at && RESTORABLE_BY.has(row.withdrawn_by) && data.length > 0 && await allKept(row, data, transaction)) {
                await row.update({ withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, updated_at: sequelize.fn('NOW') }, { transaction });
                await sequelize.query(
                    `UPDATE prv_ai_videos SET status = 'published', updated_at = NOW() WHERE native_id = :nativeId`,
                    { replacements: { nativeId: row.native_id }, transaction });
                changed = true;
            }
            return changed;
        },
    };
};
