const { QueryTypes } = require('sequelize');
const { voteRating } = require('../../lib/segment-rating');
const { ReviewInputError, KEEP_VERDICTS } = require('./review');
const { MIN_SEGMENT_SECONDS } = require('../../lib/ai-rules');

// A prv video id (`<owner>_<id>`, owner negative for a community); anything else is never queued for `ai detect`
// (ai/pipeline/queue.go nativeIDRegex is the same pattern).
const PRV_NATIVE_ID = /^-?\d+_\d+$/;
// A keep verdict never restores a row withdrawn by `admin` (the operator's switch).
const RESTORABLE_BY = new Set(['judge', 'review']);
const byStart = (a, b) => a.start - b.start;

module.exports = function createAiRepository(models, sequelize) {
    // Every entry of the row has a keep verdict as its latest one, decided after the row was withdrawn.
    // An item refers to the entry at its effective bounds (those of its latest verdict with bounds, else its own;
    // prv/repository/review.js effectiveOf), and of several items on one entry the latest verdict counts.
    async function allKept(row, data, transaction) {
        const items = await sequelize.query(
            `SELECT COALESCE(b.start, i.start) AS start, COALESCE(b."end", i."end") AS "end", l.verdict, l.decided_at
               FROM prv_review_items i
               JOIN LATERAL (SELECT verdict, decided_at FROM prv_review_verdicts v WHERE v.item_id = i.id
                              ORDER BY v.decided_at DESC, v.id DESC LIMIT 1) l ON true
               LEFT JOIN LATERAL (SELECT start, "end" FROM prv_review_verdicts v WHERE v.item_id = i.id AND v.start IS NOT NULL
                                   ORDER BY v.decided_at DESC, v.id DESC LIMIT 1) b ON true
              WHERE i.kind = 'ai' AND i.video_id = :videoId
              ORDER BY l.decided_at DESC`,
            { replacements: { videoId: row.video_id }, type: QueryTypes.SELECT, transaction });
        return data.every(e => {
            const l = items.find(it => it.start === e.start && it.end === e.end);
            return l && KEEP_VERDICTS.has(l.verdict) && l.decided_at >= row.withdrawn_at;
        });
    }

    return {
        // `views` = the count read from `viewsText` (lib/parse-views-text.js), null when unreadable. GREATEST skips
        // NULL, so a request without a readable counter never lowers or clears views_max; `views_text` keeps the
        // latest string sent, readable or not, so a new page format shows up as rows with a text and no views_max.
        async seen(nativeId, { views = null, viewsText = null } = {}) {
            if (!PRV_NATIVE_ID.test(nativeId)) return;
            await sequelize.query(
                `INSERT INTO prv_ai_videos (native_id, views_max, views_text, requests)
                 VALUES (:nativeId, :views, :viewsText, 1)
                 ON CONFLICT (native_id) DO UPDATE SET
                     views_max = GREATEST(prv_ai_videos.views_max, EXCLUDED.views_max),
                     views_text = COALESCE(EXCLUDED.views_text, prv_ai_videos.views_text),
                     requests = prv_ai_videos.requests + 1,
                     last_seen_at = CURRENT_TIMESTAMP`,
                { replacements: { nativeId, views, viewsText } });
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
         * Apply a review verdict on a kind='ai' item to its AI row, under the row's lock in the caller's
         * `transaction`. `from` is the item's effective bounds before this verdict (the entry it refers to, in `data`
         * or `hidden`), `to` the verdict's bounds (default `from`): not_ad / unclear move the entry at `from` to
         * `hidden` with reason `review` (the row is withdrawn by `review` when that empties `data`); sponsor /
         * self_promotion keep it, or put it back, with that category at `to` (`source: 'review'` once moved), in
         * `data` with the rating of the votes on the new category and bounds, or in `hidden` with reason `short` when
         * under MIN_SEGMENT_SECONDS. Bounds overlapping another served entry are refused (ReviewInputError, nothing
         * written). A row withdrawn by judge or review is served again once every served entry has a keep verdict.
         * Idempotent; returns true when the row changed.
         */
        async applyVerdict(item, verdict, { from = item, to = from, transaction }) {
            if (item.kind !== 'ai' || item.video_id == null) return false;
            const row = await models.AiVideoCalculated.findOne({
                where: { video_id: item.video_id }, lock: transaction.LOCK.UPDATE, transaction });
            if (!row) return false;
            const atFrom = e => e.start === from.start && e.end === from.end;
            const inData = row.data.findIndex(atFrom);
            const inHidden = inData === -1 ? row.hidden.findIndex(atFrom) : -1;
            const old = inData !== -1 ? row.data[inData] : row.hidden[inHidden];
            const others = { data: row.data.filter((_, i) => i !== inData), hidden: row.hidden.filter((_, i) => i !== inHidden) };
            let next = null;
            if (KEEP_VERDICTS.has(verdict)) {
                const category = await models.MarkupCategory.findOne({ where: { category: verdict }, transaction });
                // An entry put back at bounds a reviewer set is theirs, not the detector's.
                const base = old || { start: from.start, end: from.end, source: from.start === item.start && from.end === item.end ? 'ai' : 'review' };
                const moved = to.start !== base.start || to.end !== base.end;
                const same = !moved && base.category_id === category.id;
                const { rating: _, reason: __, ...rest } = base;
                const entry = { ...rest, category_id: category.id, start: to.start, end: to.end, ...(moved && { source: 'review' }) };
                if (to.end - to.start < MIN_SEGMENT_SECONDS) {
                    if (!(same && old.reason === 'short')) next = { hidden: { ...entry, reason: 'short' } };
                } else if (!(same && inData !== -1)) {
                    if (others.data.some(e => e.start < to.end && to.start < e.end)) {
                        throw new ReviewInputError(`bounds ${to.start}-${to.end} overlap another AI segment of the video`, 'bounds_overlap');
                    }
                    const rating = await voteRating(models, { videoId: row.video_id, categoryId: category.id, start: to.start, end: to.end }, { transaction });
                    next = { data: { ...entry, ...(rating ? { rating } : {}) } };
                }
            } else if (old && old.reason !== 'review') {
                const { rating: _, reason: __, ...rest } = old;
                next = { hidden: { ...rest, reason: 'review' } };
            }
            let changed = next !== null;
            const data = next ? (next.data ? [...others.data, next.data].sort(byStart) : others.data) : row.data;
            if (changed) {
                const hidden = next.hidden ? [...others.hidden, next.hidden].sort(byStart) : others.hidden;
                await row.update({ data, hidden, updated_at: sequelize.fn('NOW') }, { transaction });
            }

            if (!row.withdrawn_at && !KEEP_VERDICTS.has(verdict) && inData !== -1 && data.length === 0) {
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
