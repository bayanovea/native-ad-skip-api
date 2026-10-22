package pipeline

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lib/pq"
)

// queued is one claimed prv_ai_videos row.
type queued struct {
	nativeID string
	viewsMax sql.NullInt64
	attempts int
}

// A crashed tick leaves its rows in `fetching`; after an hour the queue takes them again.
const queueRule = `
	(status = 'seen' AND (views_max >= $1 OR (views_max IS NULL AND requests >= $2)))
	OR (status = 'queued' AND next_attempt_at <= NOW())
	OR (status = 'fetching' AND updated_at < NOW() - INTERVAL '1 hour')`

// claimQueued moves up to the tick's share of the daily budget from the queue to
// `fetching`, oldest first. The row lock is held only for the claim, so the read
// path's views upsert never waits on a yt-dlp call.
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
	rows, err := tx.Query(`SELECT native_id, views_max, attempts FROM prv_ai_videos WHERE `+queueRule+`
		ORDER BY first_seen_at, native_id LIMIT $3 FOR UPDATE SKIP LOCKED`,
		cfg.MinViews, cfg.FallbackRequests, limit)
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
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'fetching', updated_at = NOW() WHERE native_id = ANY($1)`, pq.Array(ids)); err != nil {
		return nil, err
	}
	return out, tx.Commit()
}

// claimOne is the manual single-video run: any row not already in flight, created
// when missing, regardless of views and budget.
func claimOne(db *sql.DB, nativeID string) (queued, error) {
	q := queued{nativeID: nativeID}
	if _, err := db.Exec(`INSERT INTO prv_ai_videos (native_id) VALUES ($1) ON CONFLICT (native_id) DO NOTHING`, nativeID); err != nil {
		return q, err
	}
	err := db.QueryRow(`UPDATE prv_ai_videos SET status = 'fetching', updated_at = NOW()
		WHERE native_id = $1 AND status NOT IN ('fetching', 'detecting') RETURNING views_max, attempts`, nativeID).
		Scan(&q.viewsMax, &q.attempts)
	if err == sql.ErrNoRows {
		return q, fmt.Errorf("%s is already being fetched or detected", nativeID)
	}
	return q, err
}

// viewCount reads view_count from yt-dlp's info JSON. A missing count is 0, so the
// row waits for the extension to report views instead of being fetched every tick.
func viewCount(raw []byte) int64 {
	var info struct {
		ViewCount *int64 `json:"view_count"`
	}
	if json.Unmarshal(raw, &info) != nil || info.ViewCount == nil {
		return 0
	}
	return *info.ViewCount
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
// maxFetchErrors.
func nextAttempt(attempts int, noTrack bool) (string, time.Duration) {
	d, ok := retryDelay(attempts)
	switch {
	case noTrack && !ok:
		return "no_track", 0
	case !noTrack && (attempts >= maxFetchErrors || !ok):
		return "failed", 0
	}
	return "queued", d
}

func markAttempt(db *sql.DB, q queued, noTrack bool, lastErr string) (string, error) {
	attempts := q.attempts + 1
	status, wait := nextAttempt(attempts, noTrack)
	var next any
	if status == "queued" {
		next = time.Now().Add(wait)
	}
	_, err := db.Exec(`UPDATE prv_ai_videos SET status = $2, attempts = $3, next_attempt_at = $4, last_error = $5, updated_at = NOW()
		WHERE native_id = $1`, q.nativeID, status, attempts, next, nullString(lastErr))
	return status, err
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
