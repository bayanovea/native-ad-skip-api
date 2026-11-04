package pipeline

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/lib/pq"
)

// queued is one claimed prv_ai_videos row.
type queued struct {
	nativeID string
	viewsMax sql.NullInt64
	attempts int
}

// prv_ai_videos.status values the detector sets or tests (SQL text spells them out).
const (
	statusSeen               = "seen"
	statusQueued             = "queued"
	statusFetching           = "fetching"
	statusDetecting          = "detecting"
	statusPublished          = "published"
	statusFailed             = "failed"
	statusNoTrack            = "no_track"
	statusTimelineUnreliable = "timeline_unreliable"
)

// nativeIDRegex is a native id of the provider ("-<owner>_<video>"), valid in Go and Postgres alike (PRV_NATIVE_ID
// in prv/repository/ai.js is its copy); anything else never reaches yt-dlp's URL.
const nativeIDRegex = `^-?[0-9]+_[0-9]+$`

var nativeIDPattern = regexp.MustCompile(nativeIDRegex)

// communityIDRegex is the ids the tick takes on its own: a community's video (negative owner), never a
// user's personal upload; the manual run still takes any native id.
const communityIDRegex = `^-[0-9]+_[0-9]+$`

// A crashed run leaves its row in `fetching`; after an hour the queue and a manual run take it again.
const staleFetching = `status = 'fetching' AND updated_at < NOW() - INTERVAL '1 hour'`

// A `seen` video the budget has not reached in queueMaxAge is given up: the
// dashboard's "Не дождались" counts by the same cut (`/* queue.go queueMaxAge */`).
const queueMaxAge = 14 * 24 * time.Hour

var queueRule = `native_id ~ '` + communityIDRegex + `' AND (
	(status = 'seen' AND (views_max >= $1 OR requests >= $2) AND first_seen_at > NOW() - INTERVAL '` +
	strconv.Itoa(int(queueMaxAge.Hours()/24)) + ` days')
	OR (status = 'queued' AND next_attempt_at <= NOW())
	OR (` + staleFetching + `))`

// queueScore orders the claim: the value of a detection (the admission terms
// themselves, so 20 requests weigh as much as AI_MIN_VIEWS views and the requests
// path needs no reserved share), divided by the days since the video was first
// requested (the views it would have served are already watched), × 1.5 when the
// channel's latest AI row served an ad, × 0.5 when ≥ 2 of its rows served none,
// × 0.3 when a live human sponsor / self_promotion markup already serves the video.
const queueScore = `ln(COALESCE(views_max, 0)::float / $1 + requests::float / $2 + 1)
	/ (1 + EXTRACT(epoch FROM NOW() - first_seen_at) / 86400)
	* COALESCE((SELECT factor FROM ch WHERE ch.owner = split_part(a.native_id, '_', 1)), 1)
	* CASE WHEN EXISTS (SELECT 1 FROM markups m JOIN videos v ON v.id = m.video_id
		JOIN markup_categories mc ON mc.id = m.category_id
		WHERE v.native_id = a.native_id AND m.deleted_at IS NULL
		AND mc.category IN ('sponsor', 'self_promotion')) THEN 0.3 ELSE 1 END`

const channelHistory = `WITH ch AS (
	SELECT split_part(native_id, '_', 1) AS owner,
		CASE WHEN (array_agg(COALESCE(jsonb_array_length(data), 0) > 0 ORDER BY published_at DESC))[1] THEN 1.5
			WHEN COUNT(*) >= 2 AND COUNT(*) FILTER (WHERE COALESCE(jsonb_array_length(data), 0) > 0) = 0 THEN 0.5
			ELSE 1 END AS factor
	FROM prv_ai_video_calculateds GROUP BY 1)`

// claimQueued moves up to the tick's share of the daily budget from the queue to
// `fetching`, highest queueScore first. The row lock is held only for the claim, so
// the read path's views upsert never waits on a yt-dlp call.
func claimQueued(db *sql.DB, cfg Config) ([]queued, error) {
	var runs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM prv_ai_runs WHERE created_at > NOW() - INTERVAL '24 hours'`).Scan(&runs); err != nil {
		return nil, fmt.Errorf("daily budget: %w", err)
	}
	limit := min(cfg.BatchMax, cfg.DailyBudget-runs)
	if limit <= 0 {
		return nil, nil
	}

	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(channelHistory+`
		SELECT native_id, views_max, attempts FROM prv_ai_videos a WHERE `+queueRule+`
		ORDER BY `+queueScore+` DESC, first_seen_at, native_id LIMIT $3 FOR UPDATE OF a SKIP LOCKED`,
		cfg.MinViews, cfg.MinRequests, limit)
	if err != nil {
		return nil, fmt.Errorf("queue: %w", err)
	}
	var out []queued
	var ids []string
	for rows.Next() {
		var q queued
		if err := rows.Scan(&q.nativeID, &q.viewsMax, &q.attempts); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, q)
		ids = append(ids, q.nativeID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	// queued_by records which criterion let the video in, once: a retry keeps it, and a row
	// claimed before the column existed (not `seen` any more) stays NULL.
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'fetching', updated_at = NOW(),
		queued_by = COALESCE(queued_by, CASE WHEN status <> 'seen' THEN NULL
			WHEN views_max >= $2 AND requests >= $3 THEN 'both' WHEN views_max >= $2 THEN 'views' ELSE 'requests' END)
		WHERE native_id = ANY($1)`, pq.Array(ids), cfg.MinViews, cfg.MinRequests); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// claimOne is the manual single-video run: any row not already in flight (a
// `fetching` row untouched for an hour is not), created when missing, regardless
// of views and budget. A native_id with an AI row is
// refused: a re-detect would replace data that votes, review verdicts and a
// withdrawal refer to (docs/backlog/ai-redetect.md).
func claimOne(db *sql.DB, nativeID string) (queued, error) {
	q := queued{nativeID: nativeID}
	if !nativeIDPattern.MatchString(nativeID) {
		return q, fmt.Errorf("%q is not a video id of the provider (-<owner>_<video>)", nativeID)
	}
	if _, err := db.Exec(`INSERT INTO prv_ai_videos (native_id) VALUES ($1) ON CONFLICT (native_id) DO NOTHING`, nativeID); err != nil {
		return q, err
	}
	var status string
	var stale, hasRow bool
	if err := db.QueryRow(`SELECT status, `+staleFetching+`, EXISTS (SELECT 1 FROM prv_ai_video_calculateds WHERE native_id = $1)
		FROM prv_ai_videos WHERE native_id = $1`, nativeID).Scan(&status, &stale, &hasRow); err != nil {
		return q, err
	}
	switch {
	case status == statusFetching && !stale, status == statusDetecting:
		return q, fmt.Errorf("%s is already being fetched or detected", nativeID)
	case hasRow:
		return q, fmt.Errorf("%s already has an AI row (status %s): a re-detect is not supported", nativeID, status)
	}
	// The staleness is checked again, so a cron claim in between is not taken twice.
	err := db.QueryRow(`UPDATE prv_ai_videos SET status = 'fetching', updated_at = NOW(), queued_by = COALESCE(queued_by, 'manual')
		WHERE native_id = $1 AND status = $2 AND (status <> 'fetching' OR `+staleFetching+`)
		RETURNING views_max, attempts`, nativeID, status).
		Scan(&q.viewsMax, &q.attempts)
	if err == sql.ErrNoRows {
		return q, fmt.Errorf("%s changed status meanwhile, run again", nativeID)
	}
	return q, err
}

// retrySchedule is the wait after the 1st, 2nd and 3rd fetch attempt that found no
// track (auto subtitles may not exist yet on a fresh video).
var retrySchedule = []time.Duration{6 * time.Hour, 24 * time.Hour, 72 * time.Hour}

// retryDelay is the wait before the next fetch after n attempts; false when n was the last.
func retryDelay(n int) (time.Duration, bool) {
	if n < 1 || n > len(retrySchedule) {
		return 0, false
	}
	return retrySchedule[n-1], true
}

// maxFetchErrors is how many yt-dlp failures a video gets before it is `failed`.
const maxFetchErrors = 3

// nextAttempt decides a failed fetch: the row's next status and, when it stays
// queued, the wait. noTrack retries on the full schedule, a yt-dlp error stops at
// maxFetchErrors. Both count in one `attempts`, so an error after two no-track
// tries is the third attempt and fails the video: a fetch budget per video, not
// an error count.
func nextAttempt(attempts int, noTrack bool) (string, time.Duration) {
	d, ok := retryDelay(attempts)
	switch {
	case noTrack && !ok:
		return statusNoTrack, 0
	case !noTrack && (attempts >= maxFetchErrors || !ok):
		return statusFailed, 0
	}
	return statusQueued, d
}

func markAttempt(db *sql.DB, q queued, noTrack bool, lastErr string) (string, error) {
	attempts := q.attempts + 1
	status, wait := nextAttempt(attempts, noTrack)
	var next any
	if status == statusQueued {
		next = time.Now().Add(wait)
	}
	_, err := db.Exec(`UPDATE prv_ai_videos SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = NOW()
		WHERE native_id = $1`, q.nativeID, status, attempts, next, nullString(lastErr))
	return status, err
}

// requeue puts a video back in the queue after wait without spending an attempt.
func requeue(db execer, nativeID, lastErr string, wait time.Duration) error {
	_, err := db.Exec(`UPDATE prv_ai_videos SET status = $2, next_attempt_at = $3, last_error = $4, batch_id = NULL, updated_at = NOW()
		WHERE native_id = $1`, nativeID, statusQueued, time.Now().Add(wait), nullString(lastErr))
	return err
}

func setStatus(db execer, nativeID, status, lastErr string) error {
	_, err := db.Exec(`UPDATE prv_ai_videos SET status = $2, last_error = $3, updated_at = NOW() WHERE native_id = $1`,
		nativeID, status, nullString(lastErr))
	return err
}

type execer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
