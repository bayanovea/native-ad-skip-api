const { QueryTypes } = require('sequelize');
const { VERDICTS } = require('../../lib/review-sheet');

const VALID_VERDICTS = new Set(VERDICTS);
const VALID_SOURCES = new Set(['page', 'import']);
const REVIEWER_MAX = 64;
const SIGNALS_WINDOW = 30;

// Errors a route can map to 400 (`code` tells them apart). Anything else
// thrown here is a bug or a DB failure and should stay a 500.
class ReviewInputError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ReviewInputError';
        this.code = code;
    }
}

const ITEM_COLUMNS = `
    i.id, i.batch, i.item_code, i.position, i.native_id, i.start, i."end",
    i.proposed, i.cues, i.link, i.flagged_by, i.created_at
`;

// "Has a verdict" = at least one verdict row (verdicts are append-only and
// every row carries a canonical verdict, so any row means decided).
const IS_DECIDED = 'EXISTS (SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id)';

/**
 * Review repository — prv only, backs /admin/review.
 *
 * Items come from imported review sheets (scripts/import-review-sheet.js);
 * verdicts are append-only and the latest row per item (decided_at DESC,
 * id DESC) is the verdict. `recordVerdict` is the single write entrypoint for
 * verdicts — the page and the importer both go through it.
 *
 * Blind rule: `flagged_by` is dropped from every item returned here unless the
 * item has a verdict, so no caller can leak it by accident.
 *
 * Factory shape matches `prv/repository/moderation.js`.
 */
module.exports = function createReviewRepository(models, sequelize) {
    // Attach `verdict` (latest or null) and `history` (newest first) to item
    // rows, and apply the blind rule. One query for all rows.
    async function hydrate(rows, { transaction } = {}) {
        if (rows.length === 0) return [];
        const verdicts = await sequelize.query(
            `SELECT id, item_id, verdict, comment, reviewer, source, decided_at
               FROM prv_review_verdicts
              WHERE item_id IN (:ids)
              ORDER BY item_id, decided_at DESC, id DESC`,
            { replacements: { ids: rows.map((r) => r.id) }, type: QueryTypes.SELECT, transaction }
        );
        const byItem = new Map();
        for (const v of verdicts) {
            if (!byItem.has(v.item_id)) byItem.set(v.item_id, []);
            byItem.get(v.item_id).push({
                id: v.id,
                verdict: v.verdict,
                comment: v.comment,
                reviewer: v.reviewer,
                source: v.source,
                decided_at: v.decided_at,
            });
        }
        return rows.map((r) => {
            const history = byItem.get(r.id) || [];
            const item = {
                id: r.id,
                batch: r.batch,
                item_code: r.item_code,
                position: r.position,
                native_id: r.native_id,
                start: r.start,
                end: r.end,
                proposed: r.proposed,
                cues: r.cues,
                link: r.link,
                created_at: r.created_at,
                verdict: history[0] || null,
                history,
            };
            if (item.verdict) item.flagged_by = r.flagged_by || [];
            return item;
        });
    }

    async function selectOne(whereSql, orderSql, replacements, opts = {}) {
        const rows = await sequelize.query(
            `SELECT ${ITEM_COLUMNS}
               FROM prv_review_items i
              WHERE ${whereSql}
              ORDER BY ${orderSql}
              LIMIT 1`,
            { replacements, type: QueryTypes.SELECT, transaction: opts.transaction }
        );
        const [item] = await hydrate(rows, opts);
        return item || null;
    }

    async function firstOpenItem(batch, opts = {}) {
        return selectOne(`i.batch = :batch AND NOT ${IS_DECIDED}`, 'i.position ASC, i.id ASC', { batch }, opts);
    }

    return {
        ReviewInputError,

        /**
         * All batches with progress: `[{ batch, total, decided, open }]`,
         * most recently imported first.
         */
        async listBatches() {
            return sequelize.query(
                `SELECT i.batch,
                        COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE ${IS_DECIDED})::int AS decided,
                        COUNT(*) FILTER (WHERE NOT ${IS_DECIDED})::int AS open
                   FROM prv_review_items i
                  GROUP BY i.batch
                  ORDER BY MAX(i.created_at) DESC, i.batch ASC`,
                { type: QueryTypes.SELECT }
            );
        },

        /** Progress of one batch: `{ batch, total, decided, open }` or null. */
        async getBatchProgress(batch) {
            const [row] = await sequelize.query(
                `SELECT i.batch,
                        COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE ${IS_DECIDED})::int AS decided,
                        COUNT(*) FILTER (WHERE NOT ${IS_DECIDED})::int AS open
                   FROM prv_review_items i
                  WHERE i.batch = :batch
                  GROUP BY i.batch`,
                { replacements: { batch }, type: QueryTypes.SELECT }
            );
            return row || null;
        },

        async getItem(batch, itemCode, opts = {}) {
            return selectOne('i.batch = :batch AND i.item_code = :item_code', 'i.id', { batch, item_code: itemCode }, opts);
        },

        async getItemById(itemId, opts = {}) {
            if (!Number.isInteger(itemId) || itemId <= 0) return null;
            return selectOne('i.id = :id', 'i.id', { id: itemId }, opts);
        },

        /** First undecided item by position, or null when all are decided. */
        firstOpenItem,

        /**
         * Item shown when the page has no `?item=`: the first open one, or the
         * last item by position when the whole batch is decided. Null only for
         * an unknown/empty batch.
         */
        async defaultItem(batch) {
            return (await firstOpenItem(batch))
                || selectOne('i.batch = :batch', 'i.position DESC, i.id DESC', { batch });
        },

        /**
         * Next open item after `position` (wrapping round to the first open
         * one), or null when nothing is open. Used for "save → next open".
         */
        async nextOpenItem(batch, position, opts = {}) {
            return (await selectOne(
                `i.batch = :batch AND i.position > :position AND NOT ${IS_DECIDED}`,
                'i.position ASC, i.id ASC', { batch, position }, opts
            )) || firstOpenItem(batch, opts);
        },

        /** `{ prev, next }` items by position (null at either end). */
        async neighbours(batch, position) {
            const [prev, next] = await Promise.all([
                selectOne('i.batch = :batch AND i.position < :position', 'i.position DESC, i.id DESC', { batch, position }),
                selectOne('i.batch = :batch AND i.position > :position', 'i.position ASC, i.id ASC', { batch, position }),
            ]);
            return { prev, next };
        },

        /**
         * Append a verdict row — the single write entrypoint for verdicts
         * (page and importer). Validates everything; throws ReviewInputError
         * (`code`: invalid_verdict | invalid_source | invalid_reviewer |
         * invalid_item | unknown_item) on bad input. Empty comment → null.
         */
        async recordVerdict({ item_id, verdict, comment, reviewer, source, transaction } = {}) {
            if (!VALID_VERDICTS.has(verdict)) {
                throw new ReviewInputError('invalid_verdict', `verdict must be one of ${VERDICTS.join(', ')}`);
            }
            if (!VALID_SOURCES.has(source)) {
                throw new ReviewInputError('invalid_source', `source must be 'page' or 'import', got ${source}`);
            }
            const who = typeof reviewer === 'string' ? reviewer.trim() : '';
            if (who === '' || who.length > REVIEWER_MAX) {
                throw new ReviewInputError('invalid_reviewer', `reviewer must be 1-${REVIEWER_MAX} characters`);
            }
            if (!Number.isInteger(item_id) || item_id <= 0) {
                throw new ReviewInputError('invalid_item', 'item_id must be a positive integer');
            }
            if (comment != null && typeof comment !== 'string') {
                throw new ReviewInputError('invalid_comment', 'comment must be a string');
            }
            const item = await models.ReviewItem.findByPk(item_id, { attributes: ['id'], transaction });
            if (!item) throw new ReviewInputError('unknown_item', `unknown review item ${item_id}`);

            const text = comment == null ? '' : comment.trim();
            // decided_at defaults to NOW (see prv/db/index.js).
            return models.ReviewVerdict.create({
                item_id,
                verdict,
                comment: text === '' ? null : text,
                reviewer: who,
                source,
            }, { transaction });
        },

        /**
         * User signals around a review stretch: [start − window, end + window].
         * One native_id can map to several `videos` rows (duration split), so
         * markups and segments are collected across all of them; undo/click
         * events are keyed by native_id directly. Overlap is inclusive.
         *
         * Returns `{ window: {start, end}, videos: [{id, duration}],
         *   markups: [{markup_id, interval_id, video_id, category, start, end,
         *              user_id, author_rating, author_banned}],
         *   segments: [{segment_id, video_id, category, start, end, rating,
         *               likes, dislikes}],
         *   undos, clicks }`.
         */
        async getSignals(native_id, start, end, window = SIGNALS_WINDOW) {
            const lo = Math.max(0, Number(start) - window);
            const hi = Number(end) + window;
            const replacements = { native_id, lo, hi };

            const videos = await sequelize.query(
                'SELECT id, duration FROM videos WHERE native_id = :native_id ORDER BY id',
                { replacements, type: QueryTypes.SELECT }
            );
            const result = { window: { start: lo, end: hi }, videos, markups: [], segments: [], undos: 0, clicks: 0 };

            const counts = await sequelize.query(
                `SELECT
                    (SELECT COUNT(*)::int FROM prv_events_interval_undo
                      WHERE video_native_id = :native_id AND start <= :hi AND "end" >= :lo) AS undos,
                    (SELECT COUNT(*)::int FROM prv_events_interval_click
                      WHERE video_native_id = :native_id AND start <= :hi AND "end" >= :lo) AS clicks`,
                { replacements, type: QueryTypes.SELECT }
            );
            result.undos = counts[0].undos;
            result.clicks = counts[0].clicks;

            if (videos.length === 0) return result;
            const video_ids = videos.map((v) => v.id);

            const [markups, segments] = await Promise.all([
                sequelize.query(
                    `SELECT m.id AS markup_id, mti.id AS interval_id, m.video_id,
                            mc.category, mti.start, mti."end",
                            m.internal_user_id AS user_id,
                            u.rating AS author_rating,
                            (u.banned_at IS NOT NULL) AS author_banned
                       FROM markups m
                       JOIN markup_time_intervals mti
                         ON mti.markup_id = m.id AND mti.deleted_at IS NULL
                       LEFT JOIN markup_categories mc ON mc.id = m.category_id
                       LEFT JOIN users u ON u.id = m.internal_user_id
                      WHERE m.video_id IN (:video_ids)
                        AND m.deleted_at IS NULL
                        AND mti.start <= :hi AND mti."end" >= :lo
                      ORDER BY mti.start, mti."end", m.id, mti.id`,
                    { replacements: { ...replacements, video_ids }, type: QueryTypes.SELECT }
                ),
                // Votes match a segment by (video_id, category_id, start, end),
                // the same rule as prv/routes/votes.js and the moderation CTEs.
                sequelize.query(
                    `SELECT seg.id AS segment_id, seg.video_id, mc.category,
                            seg.start, seg."end", COALESCE(seg.rating, 0) AS rating,
                            COUNT(v.id) FILTER (WHERE v.vote = 1)::int AS likes,
                            COUNT(v.id) FILTER (WHERE v.vote = -1)::int AS dislikes
                       FROM prv_calculated_segments seg
                       LEFT JOIN markup_categories mc ON mc.id = seg.category_id
                       LEFT JOIN votes v
                         ON v.video_id = seg.video_id
                        AND v.category_id = seg.category_id
                        AND v.start = seg.start
                        AND v."end" = seg."end"
                      WHERE seg.video_id IN (:video_ids)
                        AND seg.start <= :hi AND seg."end" >= :lo
                      GROUP BY seg.id, mc.category
                      ORDER BY seg.start, seg."end", seg.id`,
                    { replacements: { ...replacements, video_ids }, type: QueryTypes.SELECT }
                ),
            ]);
            result.markups = markups;
            result.segments = segments;
            return result;
        },
    };
};

module.exports.ReviewInputError = ReviewInputError;
module.exports.SIGNALS_WINDOW = SIGNALS_WINDOW;
