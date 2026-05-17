const { QueryTypes } = require('sequelize');

const VALID_TARGET_TYPES = new Set(['user', 'markup']);
const VALID_DECISIONS = new Set(['approve', 'reject']);
const VALID_DECIDED_BY = new Set(['admin', 'auto']);

// Single source of truth for scoring weights and the undo fuzzy-match window.
// Mirrored as documentation in prv/routes/admin-moderation.js; the route does
// NOT redeclare them as JS constants since the SQL below is the only consumer.
const WEIGHT_DISLIKE = 3;
const WEIGHT_UNDO = 1;
const WEIGHT_SEGMENT_RATING = 3;
const UNDO_MATCH_TOLERANCE = 2;

// CTE templates. Each function returns SQL; the optional `extraWhere` is the
// per-target filter (e.g. `AND m.internal_user_id = :user_id`) injected by
// snapshot helpers — the batched scoreboard variants pass an empty string and
// group/filter downstream.
function voteAttributionCte(extraWhere = '') {
    return `
        vote_attribution AS (
            SELECT DISTINCT ON (v.id)
                v.id              AS vote_id,
                v."createdAt"     AS vote_created_at,
                m.id              AS markup_id,
                m.internal_user_id AS author_id
            FROM votes v
            JOIN prv_calculated_segments seg
              ON seg.video_id    = v.video_id
             AND seg.category_id = v.category_id
             AND seg.start       = v.start
             AND seg."end"       = v."end"
            JOIN prv_calculated_segment_markups csm ON csm.segment_id = seg.id
            JOIN markups m ON m.id = csm.markup_id AND m.deleted_at IS NULL
            JOIN markup_time_intervals mti
              ON mti.markup_id = m.id AND mti.deleted_at IS NULL
            WHERE v.vote = -1
              ${extraWhere}
            ORDER BY v.id,
                     (ABS(mti.start - v.start) + ABS(mti."end" - v."end")) ASC,
                     m.id ASC
        )
    `;
}

function undoAttributionCte(extraWhere = '') {
    return `
        undo_attribution AS (
            SELECT DISTINCT ON (u.id)
                u.id              AS undo_id,
                u."createdAt"     AS undo_created_at,
                m.id              AS markup_id,
                m.internal_user_id AS author_id
            FROM prv_events_interval_undo u
            -- When multiple videos rows share a native_id (a data-integrity
            -- issue surfaced separately by the moderation page), join only
            -- the lowest-id row per native_id. Without this filter, a single
            -- undo would match every duplicated video row, and the downstream
            -- COUNT-based aggregations would over-attribute the undo N times.
            -- DISTINCT ON keeps attribution deterministic (lowest id wins);
            -- matches the route handler's recent_undos resolver behaviour.
            JOIN (
                SELECT DISTINCT ON (native_id) id, native_id
                FROM videos
                ORDER BY native_id, id ASC
            ) vid ON vid.native_id = u.video_native_id
            JOIN prv_calculated_segments seg
              ON seg.video_id    = vid.id
             AND seg.category_id = u.category_id
             AND ABS(seg.start - u.start) <= ${UNDO_MATCH_TOLERANCE}
             AND ABS(seg."end" - u."end") <= ${UNDO_MATCH_TOLERANCE}
            JOIN prv_calculated_segment_markups csm ON csm.segment_id = seg.id
            JOIN markups m ON m.id = csm.markup_id AND m.deleted_at IS NULL
            JOIN markup_time_intervals mti
              ON mti.markup_id = m.id AND mti.deleted_at IS NULL
            WHERE 1=1
              ${extraWhere}
            ORDER BY u.id,
                     (ABS(seg.start - u.start) + ABS(seg."end" - u."end")) ASC,
                     (ABS(mti.start - u.start) + ABS(mti."end" - u."end")) ASC,
                     m.id ASC
        )
    `;
}

/**
 * Moderation repository — prv only.
 *
 * Hosts helpers used by the admin moderation page (scoreboards, decision
 * recording), starting with the shared "closest-matching markup" rule used to
 * attribute votes/undos to a specific contributing markup.
 *
 * Factory shape matches `prv/repository/markup.js`: receives the Sequelize
 * models map and the `sequelize` instance, and returns an object of methods.
 */
module.exports = function createModerationRepository(models, sequelize) {
    /**
     * Compute the score snapshot for a SINGLE user.
     *
     * Filtered variant of `getUserScoreboard`'s aggregation. Returns `null`
     * when the user does not exist; otherwise `{ dislikes, dislikes_7d, undos,
     * undos_7d, rating, score }`. Score formula matches the batch query.
     */
    async function computeUserSnapshot(userId, recentDays = 7, { transaction } = {}) {
        const sql = `
            WITH ${voteAttributionCte('AND m.internal_user_id = :user_id')},
            ${undoAttributionCte('AND m.internal_user_id = :user_id')}
            SELECT
                u.id AS user_id,
                COALESCE(u.rating, 0) AS rating,
                (SELECT COUNT(*)::int FROM vote_attribution) AS dislikes,
                (SELECT COUNT(*) FILTER (WHERE vote_created_at >= NOW() - make_interval(days => :recent_days))::int FROM vote_attribution) AS dislikes_7d,
                (SELECT COUNT(*)::int FROM undo_attribution) AS undos,
                (SELECT COUNT(*) FILTER (WHERE undo_created_at >= NOW() - make_interval(days => :recent_days))::int FROM undo_attribution) AS undos_7d
            FROM users u
            WHERE u.id = :user_id
        `;
        const rows = await sequelize.query(sql, {
            replacements: { user_id: userId, recent_days: recentDays },
            type: QueryTypes.SELECT,
            transaction,
        });
        if (rows.length === 0) return null;
        const r = rows[0];
        const dislikes = Number(r.dislikes) || 0;
        const undos = Number(r.undos) || 0;
        return {
            dislikes,
            dislikes_7d: Number(r.dislikes_7d) || 0,
            undos,
            undos_7d: Number(r.undos_7d) || 0,
            rating: Number(r.rating) || 0,
            score: WEIGHT_DISLIKE * dislikes + WEIGHT_UNDO * undos,
        };
    }

    /**
     * Compute the score snapshot for a SINGLE markup. Returns `null` when the
     * markup does not exist or is soft-deleted.
     */
    async function computeMarkupSnapshot(markupId, recentDays = 7, { transaction } = {}) {
        const sql = `
            WITH ${voteAttributionCte()},
            ${undoAttributionCte()}
            SELECT
                m.id AS markup_id,
                (SELECT COUNT(*)::int FROM vote_attribution WHERE markup_id = m.id) AS dislikes,
                (SELECT COUNT(*) FILTER (WHERE vote_created_at >= NOW() - make_interval(days => :recent_days))::int FROM vote_attribution WHERE markup_id = m.id) AS dislikes_7d,
                (SELECT COUNT(*)::int FROM undo_attribution WHERE markup_id = m.id) AS undos,
                (SELECT COUNT(*) FILTER (WHERE undo_created_at >= NOW() - make_interval(days => :recent_days))::int FROM undo_attribution WHERE markup_id = m.id) AS undos_7d,
                COALESCE((
                    SELECT SUM(seg.rating)::int
                    FROM prv_calculated_segment_markups csm
                    JOIN prv_calculated_segments seg ON seg.id = csm.segment_id
                    WHERE csm.markup_id = m.id
                ), 0) AS segment_rating
            FROM markups m
            WHERE m.id = :markup_id
              AND m.deleted_at IS NULL
        `;
        const rows = await sequelize.query(sql, {
            replacements: { markup_id: markupId, recent_days: recentDays },
            type: QueryTypes.SELECT,
            transaction,
        });
        if (rows.length === 0) return null;
        const r = rows[0];
        const dislikes = Number(r.dislikes) || 0;
        const undos = Number(r.undos) || 0;
        const segmentRating = Number(r.segment_rating) || 0;
        return {
            dislikes,
            dislikes_7d: Number(r.dislikes_7d) || 0,
            undos,
            undos_7d: Number(r.undos_7d) || 0,
            segment_rating: segmentRating,
            score: WEIGHT_DISLIKE * dislikes + WEIGHT_UNDO * undos + WEIGHT_SEGMENT_RATING * Math.max(0, -segmentRating),
        };
    }

    return {
        // Exposed for direct reuse by other repositories / future callers; the
        // batch scoreboard queries do NOT call these (they remain standalone
        // for performance reasons).
        computeUserSnapshot,
        computeMarkupSnapshot,
        /**
         * Given a target segment `(video_id, category_id, start, end)`, find the single
         * contributing markup whose time interval is closest to that target.
         *
         * Steps (per the plan's "Closest-matching markup rule"):
         *   1. Candidate markups linked via `prv_calculated_segment_markups` to a segment whose
         *      `(category_id, video_id)` matches and whose `start`/`end` fall within `±tolerance`
         *      of the target. Use `tolerance = 0` for exact-match (votes), >0 for fuzzy (undos).
         *   2. Join `markups` (filter `deleted_at IS NULL`).
         *   3. Join `markup_time_intervals` (filter `deleted_at IS NULL`). A markup can have more
         *      than one interval; we keep the one with the smallest
         *      `abs(interval.start - target.start) + abs(interval.end - target.end)`.
         *   4. Across all candidate markups, the smallest distance wins. Tie-break by
         *      `markup.id ASC`.
         *
         * @param {{video_id:number, category_id:number, start:number, end:number, tolerance?:number}} params
         * @returns {Promise<{id:number, internal_user_id:number|null, video_id:number, category_id:number, distance:number}|null>}
         */
        async closestMarkupForTarget({ video_id, category_id, start, end, tolerance = 0 }) {
            if (video_id == null || category_id == null || start == null || end == null) {
                throw new Error('closestMarkupForTarget: video_id, category_id, start, end are required');
            }
            const tol = Number(tolerance) || 0;

            // One SQL pass: for each (markup, interval) candidate, compute the distance score and
            // pick the minimum via ORDER BY + LIMIT 1. The tie-break on `markup.id ASC` is the
            // second ORDER BY key.
            const sql = `
                SELECT
                    m.id,
                    m.internal_user_id,
                    m.video_id,
                    m.category_id,
                    (ABS(mti.start - :target_start) + ABS(mti."end" - :target_end)) AS distance
                FROM prv_calculated_segments seg
                JOIN prv_calculated_segment_markups csm ON csm.segment_id = seg.id
                JOIN markups m ON m.id = csm.markup_id
                JOIN markup_time_intervals mti ON mti.markup_id = m.id
                WHERE seg.video_id = :video_id
                  AND seg.category_id = :category_id
                  AND ABS(seg.start - :target_start) <= :tolerance
                  AND ABS(seg."end" - :target_end) <= :tolerance
                  AND m.deleted_at IS NULL
                  AND mti.deleted_at IS NULL
                ORDER BY distance ASC, m.id ASC
                LIMIT 1
            `;

            const rows = await sequelize.query(sql, {
                replacements: {
                    video_id,
                    category_id,
                    target_start: start,
                    target_end: end,
                    tolerance: tol,
                },
                type: QueryTypes.SELECT,
            });

            return rows.length === 0 ? null : rows[0];
        },

        /**
         * Build the user-level scoreboard.
         *
         * For each user (`users.id`), counts:
         *   - **dislikes**: `votes` rows with `vote = -1` attributed to the closest
         *     contributing markup (exact `(video_id, category_id, start, end)` segment match,
         *     then closest markup interval) whose `internal_user_id` is this user.
         *   - **undos**: `prv_events_interval_undo` rows mapped to a segment via fuzzy match
         *     (`±UNDO_MATCH_TOLERANCE`), then closest contributing markup.
         *   - `*_7d` variants: same but restricted to `createdAt >= NOW() - INTERVAL ':n days'`.
         *   - **rating**: `users.rating` (not part of `score`, only displayed).
         *   - **markups_total / markups_recent**: count of non-deleted markups authored.
         *
         * Score: `WEIGHT_DISLIKE * dislikes + WEIGHT_UNDO * undos`.
         *
         * When `resurfaceThreshold` is non-null, the query LEFT JOINs the most
         * recent `prv_admin_decisions` row per user and filters out users whose
         * computed score has NOT risen by at least `resurfaceThreshold` above
         * the snapshot.score captured at decision time. Rows with no prior
         * decision always pass through. This pushes the re-surface logic into
         * SQL so the LIMIT applies AFTER suppression — without it, a SQL LIMIT
         * applied before filtering could return a page full of suppressed rows
         * even when actionable rows exist beyond the LIMIT.
         *
         * @param {{limit?:number, recentDays?:number, resurfaceThreshold?:number|null}} params
         */
        async getUserScoreboard({ limit = 50, recentDays = 7, resurfaceThreshold = null } = {}) {
            const resurfaceClause = resurfaceThreshold == null
                ? ''
                : `AND (
                        latest_decision.signals_snapshot IS NULL
                        OR (
                            (${WEIGHT_DISLIKE} * COALESCE(ud.dislikes, 0) + ${WEIGHT_UNDO} * COALESCE(un.undos, 0))
                            - COALESCE((latest_decision.signals_snapshot->>'score')::numeric, 0)
                            >= :resurface_threshold
                        )
                      )`;
            const resurfaceJoin = resurfaceThreshold == null
                ? ''
                : `LEFT JOIN LATERAL (
                        SELECT signals_snapshot
                        FROM prv_admin_decisions ad
                        WHERE ad.target_type = 'user' AND ad.target_id = u.id
                        ORDER BY ad.decided_at DESC, ad.id DESC
                        LIMIT 1
                   ) latest_decision ON TRUE`;
            const sql = `
                WITH ${voteAttributionCte()},
                ${undoAttributionCte()},
                user_dislikes AS (
                    SELECT author_id AS user_id,
                           COUNT(*)::int AS dislikes,
                           COUNT(*) FILTER (WHERE vote_created_at >= NOW() - make_interval(days => :recent_days))::int AS dislikes_7d
                    FROM vote_attribution
                    WHERE author_id IS NOT NULL
                    GROUP BY author_id
                ),
                user_undos AS (
                    SELECT author_id AS user_id,
                           COUNT(*)::int AS undos,
                           COUNT(*) FILTER (WHERE undo_created_at >= NOW() - make_interval(days => :recent_days))::int AS undos_7d
                    FROM undo_attribution
                    WHERE author_id IS NOT NULL
                    GROUP BY author_id
                ),
                user_markup_counts AS (
                    SELECT internal_user_id AS user_id,
                           COUNT(*)::int AS markups_total,
                           COUNT(*) FILTER (WHERE "createdAt" >= NOW() - make_interval(days => :recent_days))::int AS markups_recent
                    FROM markups
                    WHERE deleted_at IS NULL AND internal_user_id IS NOT NULL
                    GROUP BY internal_user_id
                )
                SELECT
                    u.id        AS user_id,
                    u.prv_user_id,
                    u.banned_at,
                    COALESCE(ud.dislikes, 0)        AS dislikes,
                    COALESCE(ud.dislikes_7d, 0)     AS dislikes_7d,
                    COALESCE(un.undos, 0)           AS undos,
                    COALESCE(un.undos_7d, 0)        AS undos_7d,
                    COALESCE(u.rating, 0)           AS rating,
                    COALESCE(mc.markups_total, 0)   AS markups_total,
                    COALESCE(mc.markups_recent, 0)  AS markups_recent,
                    (${WEIGHT_DISLIKE} * COALESCE(ud.dislikes, 0) + ${WEIGHT_UNDO} * COALESCE(un.undos, 0))::int AS score
                FROM users u
                LEFT JOIN user_dislikes      ud ON ud.user_id = u.id
                LEFT JOIN user_undos         un ON un.user_id = u.id
                LEFT JOIN user_markup_counts mc ON mc.user_id = u.id
                ${resurfaceJoin}
                WHERE (COALESCE(ud.dislikes, 0) + COALESCE(un.undos, 0)) > 0
                  ${resurfaceClause}
                ORDER BY score DESC, user_id ASC
                LIMIT :limit
            `;
            const replacements = { recent_days: recentDays, limit };
            if (resurfaceThreshold != null) {
                replacements.resurface_threshold = resurfaceThreshold;
            }
            const rows = await sequelize.query(sql, {
                replacements,
                type: QueryTypes.SELECT,
            });
            return rows;
        },

        /**
         * Build the markup-level scoreboard.
         *
         * For each markup (`markups.id`, not deleted), counts:
         *   - **dislikes**: votes attributed to this markup as the closest contributor of the
         *     matching segment.
         *   - **undos**: undos attributed to this markup as the closest contributor of the
         *     matching segment (fuzzy ±2s).
         *   - **segment_rating**: SUM of `prv_calculated_segments.rating` across every segment this
         *     markup contributed to. May be negative; that negative magnitude feeds into the score.
         *
         * Score: `WEIGHT_DISLIKE * dislikes + WEIGHT_UNDO * undos + WEIGHT_SEGMENT_RATING * GREATEST(0, -segment_rating)`.
         *
         * See `getUserScoreboard` for the rationale behind `resurfaceThreshold`
         * — the same SQL-level suppression applies here against the per-markup
         * latest decision (`target_type = 'markup'`).
         *
         * @param {{limit?:number, recentDays?:number, resurfaceThreshold?:number|null}} params
         */
        async getMarkupScoreboard({ limit = 50, recentDays = 7, resurfaceThreshold = null } = {}) {
            const resurfaceClause = resurfaceThreshold == null
                ? ''
                : `AND (
                        latest_decision.signals_snapshot IS NULL
                        OR (
                            (${WEIGHT_DISLIKE} * COALESCE(md.dislikes, 0)
                             + ${WEIGHT_UNDO} * COALESCE(mu.undos, 0)
                             + ${WEIGHT_SEGMENT_RATING} * GREATEST(0, -COALESCE(msr.segment_rating, 0)))
                            - COALESCE((latest_decision.signals_snapshot->>'score')::numeric, 0)
                            >= :resurface_threshold
                        )
                      )`;
            const resurfaceJoin = resurfaceThreshold == null
                ? ''
                : `LEFT JOIN LATERAL (
                        SELECT signals_snapshot
                        FROM prv_admin_decisions ad
                        WHERE ad.target_type = 'markup' AND ad.target_id = m.id
                        ORDER BY ad.decided_at DESC, ad.id DESC
                        LIMIT 1
                   ) latest_decision ON TRUE`;
            const sql = `
                WITH ${voteAttributionCte()},
                ${undoAttributionCte()},
                markup_dislikes AS (
                    SELECT markup_id,
                           COUNT(*)::int AS dislikes,
                           COUNT(*) FILTER (WHERE vote_created_at >= NOW() - make_interval(days => :recent_days))::int AS dislikes_7d
                    FROM vote_attribution
                    GROUP BY markup_id
                ),
                markup_undos AS (
                    SELECT markup_id,
                           COUNT(*)::int AS undos,
                           COUNT(*) FILTER (WHERE undo_created_at >= NOW() - make_interval(days => :recent_days))::int AS undos_7d
                    FROM undo_attribution
                    GROUP BY markup_id
                ),
                markup_segment_rating AS (
                    SELECT csm.markup_id, COALESCE(SUM(seg.rating), 0)::int AS segment_rating
                    FROM prv_calculated_segment_markups csm
                    JOIN prv_calculated_segments seg ON seg.id = csm.segment_id
                    GROUP BY csm.markup_id
                )
                SELECT
                    m.id                                    AS markup_id,
                    COALESCE(md.dislikes, 0)                AS dislikes,
                    COALESCE(md.dislikes_7d, 0)             AS dislikes_7d,
                    COALESCE(mu.undos, 0)                   AS undos,
                    COALESCE(mu.undos_7d, 0)                AS undos_7d,
                    COALESCE(msr.segment_rating, 0)         AS segment_rating,
                    m.internal_user_id                      AS user_id,
                    u.prv_user_id                            AS prv_user_id,
                    m.video_id,
                    vid.native_id                           AS video_native_id,
                    (${WEIGHT_DISLIKE} * COALESCE(md.dislikes, 0)
                     + ${WEIGHT_UNDO} * COALESCE(mu.undos, 0)
                     + ${WEIGHT_SEGMENT_RATING} * GREATEST(0, -COALESCE(msr.segment_rating, 0)))::int AS score
                FROM markups m
                LEFT JOIN users u ON u.id = m.internal_user_id
                LEFT JOIN videos vid ON vid.id = m.video_id
                LEFT JOIN markup_dislikes        md  ON md.markup_id  = m.id
                LEFT JOIN markup_undos           mu  ON mu.markup_id  = m.id
                LEFT JOIN markup_segment_rating  msr ON msr.markup_id = m.id
                ${resurfaceJoin}
                WHERE m.deleted_at IS NULL
                  AND (
                        COALESCE(md.dislikes, 0) > 0
                     OR COALESCE(mu.undos, 0) > 0
                     OR COALESCE(msr.segment_rating, 0) < 0
                  )
                  ${resurfaceClause}
                ORDER BY score DESC, markup_id ASC
                LIMIT :limit
            `;
            const replacements = { recent_days: recentDays, limit };
            if (resurfaceThreshold != null) {
                replacements.resurface_threshold = resurfaceThreshold;
            }
            const rows = await sequelize.query(sql, {
                replacements,
                type: QueryTypes.SELECT,
            });
            return rows;
        },

        /**
         * Record an admin (or auto) decision against a single target.
         *
         * Recomputes the current score snapshot for `(target_type, target_id)`
         * via `computeUserSnapshot` / `computeMarkupSnapshot`, then inserts a
         * single row into `prv_admin_decisions` with that snapshot as JSONB.
         * This is the **single entrypoint** for writing decisions — the admin
         * POST endpoint and the auto-ban hook both call it.
         *
         * The recompute + insert MUST be atomic w.r.t. any concurrent side
         * effect on the same target. If the caller already owns a transaction,
         * pass it in via `transaction`; otherwise we open a local one.
         *
         * Returns the inserted `AdminDecision` row.
         */
        async recordDecision({ target_type, target_id, decision, decided_by, transaction } = {}) {
            // Defensive validation — admin route already validates at the HTTP
            // boundary, but the auto-ban hook passes static literals, so a
            // regression there would be silent without these guards.
            if (!VALID_TARGET_TYPES.has(target_type)) {
                throw new Error(`recordDecision: invalid target_type: ${target_type}`);
            }
            if (!VALID_DECISIONS.has(decision)) {
                throw new Error(`recordDecision: invalid decision: ${decision}`);
            }
            if (!VALID_DECIDED_BY.has(decided_by)) {
                throw new Error(`recordDecision: invalid decided_by: ${decided_by}`);
            }
            if (!Number.isInteger(target_id) || target_id <= 0) {
                throw new Error(`recordDecision: target_id must be a positive integer, got ${target_id}`);
            }

            const snapshot = target_type === 'user'
                ? await computeUserSnapshot(target_id, 7, { transaction })
                : await computeMarkupSnapshot(target_id, 7, { transaction });

            // decided_at column has `defaultValue: DataTypes.NOW` (see prv/db/index.js)
            // so we omit it here and let Sequelize/Postgres stamp the row.
            return await models.AdminDecision.create({
                target_type,
                target_id,
                decision,
                signals_snapshot: snapshot,
                decided_by,
            }, { transaction });
        },

        /**
         * Return a Map of `target_id → latest decision row` for the supplied
         * (target_type, target_ids[]). Empty input → empty Map. Uses Postgres
         * `DISTINCT ON` with `ORDER BY decided_at DESC, id DESC` (same stable
         * tiebreak as the history list in admin-moderation.js) to pick the
         * most-recent row per `target_id` in one query.
         */
        async getLatestDecisionsMap(target_type, target_ids) {
            if (!VALID_TARGET_TYPES.has(target_type)) {
                throw new Error(`getLatestDecisionsMap: invalid target_type: ${target_type}`);
            }
            if (!Array.isArray(target_ids) || target_ids.length === 0) return new Map();
            // Defensive filter — mirrors recordDecision's positive-integer
            // check at the call boundary. Callers already filter, but a stray
            // 0/NaN/string would silently produce wrong results from `IN (:list)`.
            const safeIds = target_ids.filter(id => Number.isInteger(id) && id > 0);
            if (safeIds.length === 0) return new Map();

            const sql = `
                SELECT DISTINCT ON (target_id)
                    id, target_type, target_id, decision, signals_snapshot, decided_at, decided_by
                FROM prv_admin_decisions
                WHERE target_type = :target_type
                  AND target_id IN (:target_ids)
                ORDER BY target_id, decided_at DESC, id DESC
            `;
            const rows = await sequelize.query(sql, {
                replacements: { target_type, target_ids: safeIds },
                type: QueryTypes.SELECT,
            });

            const map = new Map();
            for (const row of rows) map.set(row.target_id, row);
            return map;
        },
    };
};
