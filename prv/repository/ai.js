const { QueryTypes } = require('sequelize');
const { voteRating } = require('../../lib/segment-rating');
const { ReviewInputError, KEEP_VERDICTS } = require('./review');
const { MIN_SEGMENT_SECONDS, HIDDEN_REASONS } = require('../../lib/ai-rules');
const { cuesOver } = require('../../lib/review-sheet');
const { linkAt } = require('../../lib/player-link');

// A prv video id (`<owner>_<id>`, owner negative for a community); anything else is never queued for `ai detect`
// (ai/pipeline/queue.go nativeIDRegex is the same pattern).
const PRV_NATIVE_ID = /^-?\d+_\d+$/;
// A keep verdict never restores a row withdrawn by `admin` (the operator's switch).
const RESTORABLE_BY = new Set(['judge', 'review']);
const byStart = (a, b) => a.start - b.start;
// An entry without what its place derives: `rating` (served only) and `reason` (hidden only).
const stripDerived = ({ rating, reason, ...rest }) => rest;

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
         * `hidden` with reason `review`, at `to`, and the row is withdrawn by `review` when that empties `data`;
         * sponsor / self_promotion keep it, or put it back, with that category at `to` (`source: 'review'` once
         * moved), in `data` with the rating of the votes on the new category and bounds, or in `hidden` with reason
         * `short` when under MIN_SEGMENT_SECONDS. Served entries of the same category lying entirely inside `to`
         * are absorbed (the pieces of one ad become this entry; their votes and items are left behind); a partial
         * overlap or a covered entry of another category is refused (ReviewInputError, nothing written). A row
         * withdrawn by judge or review is served again once every served entry has a keep verdict. Idempotent;
         * returns `{ changed, absorbed }`.
         */
        async applyVerdict(item, verdict, { from = item, to = from, transaction }) {
            const none = { changed: false, absorbed: 0 };
            if (item.kind !== 'ai' || item.video_id == null) return none;
            const row = await models.AiVideoCalculated.findOne({
                where: { video_id: item.video_id }, lock: transaction.LOCK.UPDATE, transaction });
            if (!row) return none;
            let absorbed = 0;
            const atFrom = e => e.start === from.start && e.end === from.end;
            const inData = row.data.findIndex(atFrom);
            const inHidden = inData === -1 ? row.hidden.findIndex(atFrom) : -1;
            const old = inData !== -1 ? row.data[inData] : row.hidden[inHidden];
            const others = { data: row.data.filter((_, i) => i !== inData), hidden: row.hidden.filter((_, i) => i !== inHidden) };
            let toData = null, toHidden = null;
            // An entry absorbed by a merge sits inside a served one: its item is history, a verdict on it changes nothing.
            if (!old && others.data.some(e => e.start <= from.start && from.end <= e.end)) return { changed: false, absorbed: 0 };
            if (KEEP_VERDICTS.has(verdict)) {
                const category = await models.MarkupCategory.findOne({ where: { category: verdict }, transaction });
                // An entry put back at bounds a reviewer set is theirs, not the detector's.
                const base = old || { start: from.start, end: from.end, source: from.start === item.start && from.end === item.end ? 'ai' : 'review' };
                const moved = to.start !== base.start || to.end !== base.end;
                const same = !moved && base.category_id === category.id;
                const alreadyShort = same && old.reason === HIDDEN_REASONS.SHORT;
                const alreadyServed = same && inData !== -1;
                const entry = { ...stripDerived(base), category_id: category.id, start: to.start, end: to.end, ...(moved && { source: 'review' }) };
                // Items find their entry by bounds: a keep onto a hidden entry's exact bounds takes its place.
                others.hidden = others.hidden.filter(e => e.start !== to.start || e.end !== to.end);
                if (to.end - to.start < MIN_SEGMENT_SECONDS) {
                    if (!alreadyShort) toHidden = { ...entry, reason: HIDDEN_REASONS.SHORT };
                } else if (!alreadyServed) {
                    const overlapping = others.data.filter(e => e.start < to.end && to.start < e.end);
                    if (overlapping.some(e => e.category_id !== category.id || e.start < to.start || to.end < e.end)) {
                        throw new ReviewInputError(`bounds ${to.start}-${to.end} overlap another AI segment of the video`, 'bounds_overlap');
                    }
                    absorbed = overlapping.length;
                    others.data = others.data.filter(e => !overlapping.includes(e));
                    const rating = await voteRating(models, { videoId: row.video_id, categoryId: category.id, start: to.start, end: to.end }, { transaction });
                    toData = { ...entry, ...(rating ? { rating } : {}) };
                }
            } else if (old && old.reason !== HIDDEN_REASONS.REVIEW) {
                const moved = to.start !== old.start || to.end !== old.end;
                toHidden = { ...stripDerived(old), start: to.start, end: to.end, ...(moved && { source: 'review' }), reason: HIDDEN_REASONS.REVIEW };
            }
            let changed = toData !== null || toHidden !== null;
            const data = !changed ? row.data : toData ? [...others.data, toData].sort(byStart) : others.data;
            if (changed) {
                const hidden = toHidden ? [...others.hidden, toHidden].sort(byStart) : others.hidden;
                await row.update({ data, hidden, updated_at: sequelize.fn('NOW') }, { transaction });
            }

            if (!row.withdrawn_at && !KEEP_VERDICTS.has(verdict) && inData !== -1 && data.length === 0) {
                const withdrawn = await this.withdraw(row.video_id, 'review', `review: ${verdict} on ${item.batch} ${item.item_code}`, { transaction });
                return { changed: withdrawn || changed, absorbed };
            }
            if (row.withdrawn_at && RESTORABLE_BY.has(row.withdrawn_by) && data.length > 0 && await allKept(row, data, transaction)) {
                await row.update({ withdrawn_at: null, withdrawn_by: null, withdrawn_reason: null, updated_at: sequelize.fn('NOW') }, { transaction });
                await sequelize.query(
                    `UPDATE prv_ai_videos SET status = 'published', updated_at = NOW() WHERE native_id = :nativeId`,
                    { replacements: { nativeId: row.native_id }, transaction });
                changed = true;
            }
            return { changed, absorbed };
        },

        /**
         * Put the entry at `start`–`end` of AI row `videoId` (served or hidden, the row in any state) in front of an
         * assessor: one ai item in today's `ai-admin-<date>` sheet, placed by reviewRepository.openPart (the judge's
         * rule), code `M<position>`, cues from the run over the bounds, the player link at start − 2 s. Under the AI
         * row's lock, then the batch row's (the judge's order; the decide route's batch → AI row order never meets
         * it because neither adds to a batch someone holds or has a verdict in). Returns `{ outcome, batch, item_code }`
         * with outcome `created`, `open` (an item without a verdict already sits on the entry: its batch / code) or
         * `none` (no row or no entry at the bounds).
         */
        async sendToReview(videoId, { start, end }, reviewRepository, now = new Date()) {
            return sequelize.transaction(async (transaction) => {
                const row = await models.AiVideoCalculated.findOne({ where: { video_id: videoId }, lock: transaction.LOCK.UPDATE, transaction });
                const entry = row && [...row.data.map(e => ({ ...e, served: true })), ...row.hidden].find(e => e.start === start && e.end === end);
                if (!entry) return { outcome: 'none' };
                const open = (await reviewRepository.openAiItems(videoId, { transaction })).find(i => i.start === start && i.end === end);
                if (open) return { outcome: 'open', batch: open.batch, item_code: open.item_code };
                const [category, run] = await Promise.all([
                    models.MarkupCategory.findByPk(entry.category_id, { transaction }),
                    models.AiRun.findByPk(row.run_id, { attributes: ['transcript'], transaction }),
                ]);
                const sheet = `ai-admin-${now.toISOString().slice(0, 10)}`;
                const batch = await reviewRepository.openPart(sheet, 1, { transaction });
                const position = await reviewRepository.nextPosition(sheet, { transaction });
                const item = {
                    item_code: `M${position}`, position, native_id: row.native_id, start, end, proposed: category.category,
                    cues: cuesOver(run && run.transcript && run.transcript.cues, entry), link: linkAt(row.native_id, start - 2),
                    flagged_by: ['admin: sent to review',
                        `entry: ${category.category} ${entry.confidence}, ${end - start} s, ${entry.served ? 'served' : `hidden: ${entry.reason}`}`],
                    kind: 'ai', video_id: videoId,
                };
                await reviewRepository.insertItems(sheet, batch, [item], { transaction });
                return { outcome: 'created', batch, item_code: item.item_code };
            });
        },

        // The row's served entries as `{ category, start, end }` (category by name), or [] without a row.
        async servedEntries(videoId, { transaction } = {}) {
            const row = await models.AiVideoCalculated.findByPk(videoId, { attributes: ['data'], transaction });
            if (!row) return [];
            const categories = await models.MarkupCategory.findAll({ transaction });
            const name = Object.fromEntries(categories.map(c => [c.id, c.category]));
            return row.data.map(e => ({ category: name[e.category_id] || String(e.category_id), start: e.start, end: e.end }));
        },
    };
};
