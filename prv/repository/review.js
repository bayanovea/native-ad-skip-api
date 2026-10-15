const { QueryTypes } = require('sequelize');
const { VERDICTS } = require('../../lib/review-sheet');

const VALID_VERDICTS = new Set(VERDICTS);
const VALID_SOURCES = new Set(['page', 'import']);
const REVIEWER_MAX = 64;
const SIGNALS_WINDOW = 30;
// item_id is a Postgres INTEGER; anything larger fails in the DB (500), not as input.
const MAX_ITEM_ID = 2147483647;

// Bad input from a caller: the decide route maps it to 400 and sends the
// message. Anything else thrown here is a bug or a DB failure (500).
class ReviewInputError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReviewInputError';
    }
}

function validItemId(id) {
    return Number.isInteger(id) && id > 0 && id <= MAX_ITEM_ID;
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
    async function hydrate(rows) {
        if (rows.length === 0) return [];
        const verdicts = await sequelize.query(
            `SELECT id, item_id, verdict, comment, reviewer, source, decided_at
               FROM prv_review_verdicts
              WHERE item_id IN (:ids)
              ORDER BY item_id, decided_at DESC, id DESC`,
            { replacements: { ids: rows.map((r) => r.id) }, type: QueryTypes.SELECT }
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
            const { flagged_by, ...columns } = r;
            const item = { ...columns, verdict: history[0] || null, history };
            if (item.verdict) item.flagged_by = flagged_by || [];
            return item;
        });
    }

    // One full item (hydrated, blind rule applied) or null.
    async function selectOne(whereSql, orderSql, replacements) {
        const rows = await sequelize.query(
            `SELECT ${ITEM_COLUMNS}
               FROM prv_review_items i
              WHERE ${whereSql}
              ORDER BY ${orderSql}
              LIMIT 1`,
            { replacements, type: QueryTypes.SELECT }
        );
        const [item] = await hydrate(rows);
        return item || null;
    }

    // Navigation reference `{ item_code, decided, link }` or null — one light
    // query, no verdict history.
    async function selectNav(whereSql, orderSql, replacements) {
        const [row] = await sequelize.query(
            `SELECT i.item_code, ${IS_DECIDED} AS decided, i.link
               FROM prv_review_items i
              WHERE ${whereSql}
              ORDER BY ${orderSql}
              LIMIT 1`,
            { replacements, type: QueryTypes.SELECT }
        );
        return row || null;
    }

    // Progress rows `{ batch, total, decided, open }`, optionally for one batch.
    function batchProgress(batch) {
        return sequelize.query(
            `SELECT i.batch,
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE ${IS_DECIDED})::int AS decided,
                    COUNT(*) FILTER (WHERE NOT ${IS_DECIDED})::int AS open
               FROM prv_review_items i
              ${batch == null ? '' : 'WHERE i.batch = :batch'}
              GROUP BY i.batch
              ORDER BY MAX(i.created_at) DESC, i.batch ASC`,
            { replacements: { batch }, type: QueryTypes.SELECT }
        );
    }

    const OPEN_IN_BATCH = `i.batch = :batch AND NOT ${IS_DECIDED}`;

    return {
        /**
         * All batches with progress: `[{ batch, total, decided, open }]`,
         * most recently imported first.
         */
        listBatches() {
            return batchProgress(null);
        },

        /** Progress of one batch: `{ batch, total, decided, open }` or null. */
        async getBatchProgress(batch) {
            const [row] = await batchProgress(batch);
            return row || null;
        },

        getItem(batch, itemCode) {
            return selectOne('i.batch = :batch AND i.item_code = :item_code', 'i.id', { batch, item_code: itemCode });
        },

        getItemById(itemId) {
            if (!validItemId(itemId)) return Promise.resolve(null);
            return selectOne('i.id = :id', 'i.id', { id: itemId });
        },

        /**
         * Item shown when the page has no `?item=`: the first open one, or the
         * last item by position when the whole batch is decided. Null only for
         * an unknown/empty batch.
         */
        async defaultItem(batch) {
            return (await selectOne(OPEN_IN_BATCH, 'i.position ASC, i.id ASC', { batch }))
                || selectOne('i.batch = :batch', 'i.position DESC, i.id DESC', { batch });
        },

        /** First undecided item by position as `{ item_code, decided, link }`, or null. */
        firstOpenItem(batch) {
            return selectNav(OPEN_IN_BATCH, 'i.position ASC, i.id ASC', { batch });
        },

        /**
         * Next open item after `position` (wrapping round to the first open
         * one) as `{ item_code, decided, link }`, or null when nothing is open.
         * Used for "save → next open".
         */
        async nextOpenItem(batch, position) {
            return (await selectNav(`${OPEN_IN_BATCH} AND i.position > :position`, 'i.position ASC, i.id ASC', { batch, position }))
                || selectNav(OPEN_IN_BATCH, 'i.position ASC, i.id ASC', { batch });
        },

        /** `{ prev, next }` by position as `{ item_code, decided, link }` (null at either end). */
        async neighbours(batch, position) {
            const [prev, next] = await Promise.all([
                selectNav('i.batch = :batch AND i.position < :position', 'i.position DESC, i.id DESC', { batch, position }),
                selectNav('i.batch = :batch AND i.position > :position', 'i.position ASC, i.id ASC', { batch, position }),
            ]);
            return { prev, next };
        },

        /**
         * Insert sheet items into `batch`, keeping any item code already there
         * (ON CONFLICT DO NOTHING). Returns the codes split into
         * `{ inserted, present }`. Used by scripts/import-review-sheet.js.
         */
        async insertItems(batch, items, { transaction } = {}) {
            const inserted = [];
            const present = [];
            for (const it of items) {
                const rows = await sequelize.query(
                    // created_at is explicit: a prv_review_items created before
                    // the column default existed has none (NOT NULL fails
                    // before ON CONFLICT is considered).
                    `INSERT INTO prv_review_items
                        (batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by, created_at)
                     VALUES (:batch, :item_code, :position, :native_id, :start, :end, :proposed, :cues, :link, :flagged_by, CURRENT_TIMESTAMP)
                     ON CONFLICT (batch, item_code) DO NOTHING
                     RETURNING id`,
                    {
                        replacements: {
                            batch,
                            item_code: it.item_code,
                            position: it.position,
                            native_id: it.native_id,
                            start: it.start,
                            end: it.end,
                            proposed: it.proposed,
                            cues: it.cues,
                            link: it.link,
                            flagged_by: JSON.stringify(it.flagged_by),
                        },
                        type: QueryTypes.SELECT,
                        transaction,
                    }
                );
                (rows.length ? inserted : present).push(it.item_code);
            }
            return { inserted, present };
        },

        /**
         * Every item of `batch` as `{ id, item_code, native_id, start, end,
         * proposed, has_verdict }` — raw rows for the importer's identity
         * check, no blind rule (flagged_by is not selected).
         */
        itemsInBatch(batch, { transaction } = {}) {
            return sequelize.query(
                `SELECT i.id, i.item_code, i.native_id, i.start, i."end", i.proposed,
                        ${IS_DECIDED} AS has_verdict
                   FROM prv_review_items i
                  WHERE i.batch = :batch`,
                { replacements: { batch }, type: QueryTypes.SELECT, transaction }
            );
        },

        /**
         * Append a verdict row — the single write entrypoint for verdicts
         * (page and importer). Validates everything and throws
         * ReviewInputError on bad input; reviewer and comment are trimmed,
         * empty comment → null. Returns the created row.
         */
        async recordVerdict({ item_id, verdict, comment, reviewer, source, transaction } = {}) {
            // source is set by the callers themselves, never by user input.
            if (!VALID_SOURCES.has(source)) throw new Error(`recordVerdict: bad source ${source}`);
            if (!VALID_VERDICTS.has(verdict)) {
                throw new ReviewInputError(`verdict must be one of ${VERDICTS.join(', ')}`);
            }
            const who = typeof reviewer === 'string' ? reviewer.trim() : '';
            if (who === '' || who.length > REVIEWER_MAX) {
                throw new ReviewInputError(`reviewer must be 1-${REVIEWER_MAX} characters`);
            }
            if (!validItemId(item_id)) {
                throw new ReviewInputError('item_id must be a positive integer');
            }
            if (comment != null && typeof comment !== 'string') {
                throw new ReviewInputError('comment must be a string');
            }
            const item = await models.ReviewItem.findByPk(item_id, { attributes: ['id'], transaction });
            if (!item) throw new ReviewInputError(`unknown review item ${item_id}`);

            const text = comment == null ? '' : comment.trim();
            // decided_at comes from the DB clock (column default, see prv/db/index.js).
            return models.ReviewVerdict.create({
                item_id,
                verdict,
                comment: text === '' ? null : text,
                reviewer: who,
                source,
            }, { transaction });
        },

        /**
         * User signals around a review stretch: [start − SIGNALS_WINDOW,
         * end + SIGNALS_WINDOW], clamped at 0.
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
        async getSignals(native_id, start, end) {
            const lo = Math.max(0, Number(start) - SIGNALS_WINDOW);
            const hi = Number(end) + SIGNALS_WINDOW;
            const replacements = { native_id, lo, hi };

            const [videos, [counts]] = await Promise.all([
                sequelize.query(
                    'SELECT id, duration FROM videos WHERE native_id = :native_id ORDER BY id',
                    { replacements, type: QueryTypes.SELECT }
                ),
                sequelize.query(
                    `SELECT
                        (SELECT COUNT(*)::int FROM prv_events_interval_undo
                          WHERE video_native_id = :native_id AND start <= :hi AND "end" >= :lo) AS undos,
                        (SELECT COUNT(*)::int FROM prv_events_interval_click
                          WHERE video_native_id = :native_id AND start <= :hi AND "end" >= :lo) AS clicks`,
                    { replacements, type: QueryTypes.SELECT }
                ),
            ]);
            const result = {
                window: { start: lo, end: hi },
                videos,
                markups: [],
                segments: [],
                undos: counts.undos,
                clicks: counts.clicks,
            };

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
module.exports.REVIEWER_MAX = REVIEWER_MAX;
