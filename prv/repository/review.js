const { QueryTypes } = require('sequelize');
const { VERDICTS } = require('../../lib/review-sheet');
const { REVIEWER_MAX } = require('../../lib/reviewer-name');

const VALID_VERDICTS = new Set(VERDICTS);
const VALID_SOURCES = new Set(['page', 'import']);
// Video-level flags a reviewer may set (prv_review_video_flags.flag).
const VIDEO_FLAGS = ['track_mismatch'];
const VALID_FLAGS = new Set(VIDEO_FLAGS);
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

// The batch is not in a state that allows the action for this reviewer
// (a route maps it to 409). `reason` is the reviewer's batch state
// (`available`, `locked`, `done`, `closed`); `locked_by` the current holder, if any.
class ReviewConflictError extends Error {
    constructor(reason, locked_by = null) {
        super(locked_by ? `batch ${reason} by ${locked_by}` : `batch ${reason}`);
        this.name = 'ReviewConflictError';
        this.reason = reason;
        this.locked_by = locked_by;
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
const DECIDED_BY_REVIEWER = 'EXISTS (SELECT 1 FROM prv_review_verdicts v WHERE v.item_id = i.id AND v.reviewer = :reviewer)';

// Reviewers with a verdict on every item (`finished`) of the batch named by
// the SQL expression `batch`.
const finishedOf = (batch) => `ARRAY(
    SELECT v.reviewer FROM prv_review_verdicts v JOIN prv_review_items wi ON wi.id = v.item_id
     WHERE wi.batch = ${batch} GROUP BY v.reviewer
    HAVING COUNT(DISTINCT v.item_id) = (SELECT COUNT(*) FROM prv_review_items ti WHERE ti.batch = ${batch})
     ORDER BY v.reviewer)`;

// `:reviewer` may take the batch: nobody holds it, they are not excluded and
// have not finished it, and it still needs a review. Someone who gave up
// halfway may come back only until then, so their late verdicts never
// override a complete review. `b` has the batch columns, `w` the `finished` array.
const availableTo = (b, w) => `(${b}.locked_by IS NULL
    AND NOT (:reviewer = ANY(${b}.excluded))
    AND NOT (:reviewer = ANY(${w}.finished))
    AND cardinality(${w}.finished) < ${b}.reviews_needed)`;

// Batch states in which the reviewer may record verdicts.
function mayDecide(state) {
    return state === 'mine' || state === 'done';
}

// Excluded reviewers see `closed` even while someone holds the batch: it can never be theirs.
const STATE = `CASE
    WHEN s.locked_by = :reviewer THEN 'mine'
    WHEN :reviewer = ANY(s.finished) THEN 'done'
    WHEN :reviewer = ANY(s.excluded) THEN 'closed'
    WHEN s.locked_by IS NOT NULL THEN 'locked'
    WHEN ${availableTo('s', 's')} THEN 'available'
    ELSE 'closed' END`;

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
    // query, no verdict history. `decided` is by `:reviewer`.
    async function selectNav(whereSql, orderSql, replacements) {
        const [row] = await sequelize.query(
            `SELECT i.item_code, ${DECIDED_BY_REVIEWER} AS decided, i.link
               FROM prv_review_items i
              WHERE ${whereSql}
              ORDER BY ${orderSql}
              LIMIT 1`,
            { replacements, type: QueryTypes.SELECT }
        );
        return row || null;
    }

    // Progress rows of `reviewer`: `{ batch, total, decided, open,
    // reviews_needed, finished, locked_by, locked_at, state }`, where
    // decided/open count that reviewer's verdicts. `batch` narrows to one.
    // Inner join: the importer and lib/schema.js give every batch a row.
    function batchProgress({ batch = null, reviewer, transaction } = {}) {
        return sequelize.query(
            `WITH p AS (
                SELECT i.batch,
                       COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE ${DECIDED_BY_REVIEWER})::int AS decided,
                       MAX(i.created_at) AS imported_at
                  FROM prv_review_items i
                 ${batch != null ? 'WHERE i.batch = :batch' : ''}
                 GROUP BY i.batch
             ), s AS (
                SELECT p.*, b.reviews_needed, b.excluded, b.locked_by, b.locked_at,
                       ${finishedOf('p.batch')} AS finished
                  FROM p JOIN prv_review_batches b ON b.batch = p.batch
             )
             SELECT s.batch, s.total, s.decided, s.total - s.decided AS open,
                    s.reviews_needed, s.finished, s.locked_by, s.locked_at, ${STATE} AS state
               FROM s
              ORDER BY s.imported_at DESC, s.batch ASC`,
            { replacements: { batch, reviewer }, type: QueryTypes.SELECT, transaction }
        );
    }

    const OPEN_IN_BATCH = `i.batch = :batch AND NOT ${DECIDED_BY_REVIEWER}`;

    return {
        /**
         * Batches with `reviewer`'s progress and state (see batchProgress),
         * most recently imported first. Without `all`, only the batches that
         * concern the reviewer (state other than `closed`).
         */
        async listBatches({ reviewer, all = false } = {}) {
            const rows = await batchProgress({ reviewer });
            return all ? rows : rows.filter((r) => r.state !== 'closed');
        },

        /** `reviewer`'s progress and state of one batch, or null. */
        async getBatchProgress(batch, reviewer, { transaction } = {}) {
            const [row] = await batchProgress({ batch, reviewer, transaction });
            return row || null;
        },

        /**
         * Lock `batch` on `reviewer` when it is available to them. Returns
         * `{ batch, locked_by, locked_at }` (also when they hold it already),
         * null for an unknown batch; throws ReviewConflictError otherwise.
         */
        async takeBatch(batch, reviewer) {
            if (!(await this.isReviewer(reviewer))) throw new ReviewInputError(`unknown reviewer ${reviewer}`);
            const row = await this.lockIfAvailable(batch, reviewer);
            if (row) return row;
            const progress = await this.getBatchProgress(batch, reviewer);
            if (!progress) return null;
            if (progress.state === 'mine') return { batch, locked_by: reviewer, locked_at: progress.locked_at };
            if (progress.state === 'available') {
                // The holder released it after the UPDATE: try once more.
                const retry = await this.lockIfAvailable(batch, reviewer);
                if (retry) return retry;
            }
            throw new ReviewConflictError(progress.state, progress.locked_by);
        },

        /**
         * Clear the lock of `batch`: the holder gives up, or `force` releases
         * someone else's. Verdicts stay. Returns `{ batch, locked_by: null,
         * locked_at: null }` (also when nobody held it), null for an unknown
         * batch; throws ReviewConflictError when another reviewer holds it
         * and `force` is not set.
         */
        async releaseBatch(batch, reviewer, { force = false } = {}) {
            if (!(await this.isReviewer(reviewer))) throw new ReviewInputError(`unknown reviewer ${reviewer}`);
            const [row] = await sequelize.query(
                `UPDATE prv_review_batches SET locked_by = NULL, locked_at = NULL
                  WHERE batch = :batch AND (locked_by = :reviewer OR :force)
                  RETURNING batch, locked_by, locked_at`,
                { replacements: { batch, reviewer, force }, type: QueryTypes.SELECT }
            );
            if (row) return row;
            const current = await models.ReviewBatch.findByPk(batch, { attributes: ['locked_by'] });
            if (!current) return null;
            if (current.locked_by == null) return { batch, locked_by: null, locked_at: null };
            throw new ReviewConflictError('locked', current.locked_by);
        },

        /**
         * Lock the `batch` row (FOR UPDATE) for the rest of `transaction`, so a
         * take or release waits until it commits. Returns its holder, or null.
         */
        async lockBatchRow(batch, { transaction }) {
            const [row] = await sequelize.query('SELECT locked_by FROM prv_review_batches WHERE batch = :batch FOR UPDATE',
                { replacements: { batch }, type: QueryTypes.SELECT, transaction });
            return row ? row.locked_by : null;
        },

        /** Run `fn(transaction)` in one transaction with the `batch` row locked (lockBatchRow). */
        withBatchLock(batch, fn) {
            return sequelize.transaction(async (transaction) => {
                await this.lockBatchRow(batch, { transaction });
                return fn(transaction);
            });
        },

        /**
         * Clear `reviewer`'s lock on `batch` once they have a verdict on every
         * item (called after each verdict). Returns true when it released.
         */
        async releaseIfFinished(batch, reviewer, { transaction } = {}) {
            const rows = await sequelize.query(
                `UPDATE prv_review_batches SET locked_by = NULL, locked_at = NULL
                  WHERE batch = :batch AND locked_by = :reviewer AND :reviewer = ANY(${finishedOf(':batch')})
                  RETURNING batch`,
                { replacements: { batch, reviewer }, type: QueryTypes.SELECT, transaction }
            );
            return rows.length > 0;
        },

        /**
         * Lock `batch` on `reviewer` when it is available to them — one
         * statement, so of two concurrent takes exactly one wins. Returns
         * `{ batch, locked_by, locked_at }`, or null when it did not lock.
         */
        async lockIfAvailable(batch, reviewer, { transaction } = {}) {
            const [row] = await sequelize.query(
                `UPDATE prv_review_batches b SET locked_by = :reviewer, locked_at = CURRENT_TIMESTAMP
                   FROM (SELECT ${finishedOf(':batch')} AS finished) w
                  WHERE b.batch = :batch AND ${availableTo('b', 'w')}
                  RETURNING b.batch, b.locked_by, b.locked_at`,
                { replacements: { batch, reviewer }, type: QueryTypes.SELECT, transaction }
            );
            return row || null;
        },

        /** Reviewer codes the page offers, alphabetical. */
        async listReviewers() {
            const rows = await sequelize.query(
                'SELECT code FROM prv_review_reviewers ORDER BY code', { type: QueryTypes.SELECT });
            return rows.map((r) => r.code);
        },

        /**
         * Register a reviewer under `code`, a name already cleaned by
         * lib/reviewer-name.js (the route checks it); returns the code, or null
         * when it is taken in any letter case. Case is compared in JS: Postgres
         * lower() under a C locale folds ASCII only. The table lock keeps two
         * concurrent "Анна" / "анна" from both passing.
         */
        async createReviewer(code) {
            return sequelize.transaction(async (transaction) => {
                await sequelize.query('LOCK TABLE prv_review_reviewers IN EXCLUSIVE MODE', { transaction });
                const taken = (await sequelize.query('SELECT code FROM prv_review_reviewers', { type: QueryTypes.SELECT, transaction }))
                    .some((r) => r.code.toLowerCase() === code.toLowerCase());
                if (taken) return null;
                await models.ReviewReviewer.create({ code }, { transaction });
                return code;
            });
        },

        /** True when `code` is a registered reviewer. */
        async isReviewer(code, { transaction } = {}) {
            if (typeof code !== 'string' || code === '') return false;
            const row = await models.ReviewReviewer.findByPk(code, { attributes: ['code'], transaction });
            return row != null;
        },

        /**
         * Register `batch` with how many reviewers must finish it and who may
         * never take it. An existing batch keeps its row; asking for other
         * values than the stored ones throws ReviewInputError, so an import
         * never silently re-routes a batch (an option left null or out is not asked).
         */
        async createBatch(batch, { reviews_needed, excluded } = {}, { transaction } = {}) {
            if (reviews_needed != null && !(Number.isInteger(reviews_needed) && reviews_needed >= 1)) {
                throw new ReviewInputError('reviews_needed must be a positive integer');
            }
            if (excluded != null) {
                if (!Array.isArray(excluded)) throw new ReviewInputError('excluded must be a list of reviewers');
                for (const code of excluded) {
                    if (!(await this.isReviewer(code, { transaction }))) throw new ReviewInputError(`unknown reviewer ${code}`);
                }
            }
            const codes = excluded == null ? null : [...new Set(excluded)].sort();
            const existing = await models.ReviewBatch.findByPk(batch, { transaction });
            if (existing) {
                if (reviews_needed != null && existing.reviews_needed !== reviews_needed) {
                    throw new ReviewInputError(`batch ${batch} needs ${existing.reviews_needed} review(s), not ${reviews_needed}`);
                }
                const stored = [...existing.excluded].sort();
                if (codes != null && stored.join(',') !== codes.join(',')) {
                    throw new ReviewInputError(`batch ${batch} excludes {${stored.join(',')}}, not {${codes.join(',')}}`);
                }
                return existing;
            }
            return models.ReviewBatch.create({
                batch,
                ...(reviews_needed != null && { reviews_needed }),
                ...(codes != null && { excluded: codes }),
            }, { transaction });
        },

        /**
         * Latest value of a video flag as `{ value, reviewer, created_at }`,
         * or null when nobody has set it.
         */
        async getVideoFlag(native_id, flag, { transaction } = {}) {
            const [row] = await sequelize.query(
                `SELECT value, reviewer, created_at FROM prv_review_video_flags
                  WHERE native_id = :native_id AND flag = :flag
                  ORDER BY created_at DESC, id DESC LIMIT 1`,
                { replacements: { native_id, flag }, type: QueryTypes.SELECT, transaction }
            );
            return row || null;
        },

        /**
         * Append a video flag row. Validates flag, value (boolean) and reviewer;
         * throws ReviewInputError on bad input. Returns the created row.
         */
        async setVideoFlag({ native_id, flag, value, reviewer, transaction } = {}) {
            if (!VALID_FLAGS.has(flag)) throw new ReviewInputError(`flag must be one of ${VIDEO_FLAGS.join(', ')}`);
            if (typeof value !== 'boolean') throw new ReviewInputError(`${flag} must be true or false`);
            if (typeof native_id !== 'string' || native_id === '') throw new ReviewInputError('native_id required');
            if (!(await this.isReviewer(reviewer, { transaction }))) throw new ReviewInputError(`unknown reviewer ${reviewer}`);
            return models.ReviewVideoFlag.create({ native_id, flag, value, reviewer }, { transaction });
        },

        getItem(batch, itemCode) {
            return selectOne('i.batch = :batch AND i.item_code = :item_code', 'i.id', { batch, item_code: itemCode });
        },

        getItemById(itemId) {
            if (!validItemId(itemId)) return Promise.resolve(null);
            return selectOne('i.id = :id', 'i.id', { id: itemId });
        },

        /**
         * Item shown when the page has no `?item=`: the first one `reviewer`
         * has not decided, or the last item by position when they have
         * decided them all. Null only for an unknown/empty batch.
         */
        async defaultItem(batch, reviewer) {
            return (await selectOne(OPEN_IN_BATCH, 'i.position ASC, i.id ASC', { batch, reviewer }))
                || selectOne('i.batch = :batch', 'i.position DESC, i.id DESC', { batch });
        },

        /**
         * Navigation helpers below return `{ item_code, decided, link }` refs;
         * "open" and `decided` are by `reviewer`, so a second reviewer starts at
         * the first item. First open item by position, or null.
         */
        firstOpenItem(batch, reviewer) {
            return selectNav(OPEN_IN_BATCH, 'i.position ASC, i.id ASC', { batch, reviewer });
        },

        /**
         * Next open item after `position`, wrapping round to the first open
         * one, or null when nothing is open. Used for "save → next open".
         */
        async nextOpenItem(batch, position, reviewer) {
            return (await selectNav(`${OPEN_IN_BATCH} AND i.position > :position`, 'i.position ASC, i.id ASC', { batch, position, reviewer }))
                || selectNav(OPEN_IN_BATCH, 'i.position ASC, i.id ASC', { batch, reviewer });
        },

        /** `{ prev, next }` by position (null at either end). */
        async neighbours(batch, position, reviewer) {
            const [prev, next] = await Promise.all([
                selectNav('i.batch = :batch AND i.position < :position', 'i.position DESC, i.id DESC', { batch, position, reviewer }),
                selectNav('i.batch = :batch AND i.position > :position', 'i.position ASC, i.id ASC', { batch, position, reviewer }),
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
         * ReviewInputError on bad input; reviewer (a code from
         * prv_review_reviewers) and comment are trimmed, empty comment → null.
         * Returns the created row.
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
            if (!(await this.isReviewer(who, { transaction }))) {
                throw new ReviewInputError(`unknown reviewer ${who}`);
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
module.exports.ReviewConflictError = ReviewConflictError;
module.exports.mayDecide = mayDecide;
module.exports.SIGNALS_WINDOW = SIGNALS_WINDOW;
module.exports.VIDEO_FLAGS = VIDEO_FLAGS;
