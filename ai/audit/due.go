package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/lib/pq"
)

// OwnerReviewer is the owner's code (prv/repository/review.js OWNER_REVIEWER): batches only
// they finished are not audited, and only they see the findings.
const OwnerReviewer = "bayanovea"

// settle and window bound the newest verdict of a due batch: a finisher has time to fix a
// verdict, and switching the audit on does not audit the whole history.
const (
	settle = 30 * time.Minute
	window = 7 * 24 * time.Hour
)

// finishedSQL is finishedOf of prv/repository/review.js for the batch column b.batch.
const finishedSQL = `ARRAY(
	SELECT v.reviewer FROM prv_review_verdicts v JOIN prv_review_items wi ON wi.id = v.item_id
	 WHERE wi.batch = b.batch GROUP BY v.reviewer
	HAVING COUNT(DISTINCT v.item_id) = (SELECT COUNT(*) FROM prv_review_items ti WHERE ti.batch = b.batch)
	 ORDER BY v.reviewer)`

// dueSQL: finished by as many reviewers as needed and by someone other than the owner, free,
// newest verdict between settle and window old and newer than the latest audit's watermark.
var dueSQL = fmt.Sprintf(`
	WITH s AS (
		SELECT b.batch, b.reviews_needed, b.locked_by, %s AS finished,
		       (SELECT MAX(v.decided_at) FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id WHERE i.batch = b.batch) AS last_at,
		       (SELECT MAX(v.id) FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id WHERE i.batch = b.batch) AS watermark
		  FROM prv_review_batches b)
	SELECT s.batch FROM s
	 WHERE s.locked_by IS NULL
	   AND cardinality(s.finished) > 0 AND cardinality(s.finished) >= s.reviews_needed
	   AND EXISTS (SELECT 1 FROM unnest(s.finished) f WHERE f <> $1)
	   AND s.last_at BETWEEN NOW() - make_interval(secs => $2) AND NOW() - make_interval(secs => $3)
	   AND s.watermark > COALESCE((SELECT MAX(a.watermark) FROM prv_review_audits a WHERE a.batch = s.batch), 0)
	 ORDER BY s.last_at`, finishedSQL)

func dueBatches(db *sql.DB) ([]string, error) {
	rows, err := db.Query(dueSQL, OwnerReviewer, window.Seconds(), settle.Seconds())
	if err != nil {
		return nil, fmt.Errorf("due batches: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var b string
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// errNotFinished refuses a manual run on a batch that still needs verdicts.
var errNotFinished = errors.New("not finished")

type item struct {
	ID        int
	Code      string
	Kind      string // sheet | ai
	Sheet     string
	NativeID  string
	VideoID   sql.NullInt64
	Start     float64
	End       float64
	Proposed  string
	Cues      string
	FlaggedBy []string
}

type verdict struct {
	ID        int
	ItemID    int
	Verdict   string
	Comment   string
	Reviewer  string
	Start     sql.NullInt64
	End       sql.NullInt64
	DecidedAt time.Time
}

func (v verdict) hasBounds() bool { return v.Start.Valid && v.End.Valid }

// batchData is one consistent read of a batch: its items (by position), every verdict
// (oldest first), its finishers and the latest track_mismatch per native_id.
type batchData struct {
	Batch         string
	ReviewsNeeded int
	Finished      []string
	Items         []item
	Verdicts      []verdict
	Track         map[string]bool
	Watermark     int
}

// readBatch reads the batch in one repeatable-read, read-only transaction, so every number of
// the audit comes from the same snapshot; it takes no row lock.
func readBatch(db *sql.DB, batch string) (*batchData, error) {
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	d := &batchData{Batch: batch, Track: map[string]bool{}}
	var finished pq.StringArray
	err = tx.QueryRow(fmt.Sprintf(`SELECT b.reviews_needed, %s FROM prv_review_batches b WHERE b.batch = $1`, finishedSQL), batch).
		Scan(&d.ReviewsNeeded, &finished)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("unknown batch %s", batch)
	}
	if err != nil {
		return nil, fmt.Errorf("batch: %w", err)
	}
	d.Finished = finished
	if len(d.Finished) == 0 || len(d.Finished) < d.ReviewsNeeded {
		return nil, fmt.Errorf("batch %s: %w (%d of %d reviews)", batch, errNotFinished, len(d.Finished), d.ReviewsNeeded)
	}

	rows, err := tx.Query(`SELECT id, item_code, kind, COALESCE(sheet, batch), native_id, video_id, start, "end", proposed,
			COALESCE(cues, ''), COALESCE(flagged_by, '[]'::jsonb)
		  FROM prv_review_items WHERE batch = $1 ORDER BY position, id`, batch)
	if err != nil {
		return nil, fmt.Errorf("items: %w", err)
	}
	var natives []string
	for rows.Next() {
		var it item
		var flagged []byte
		if err := rows.Scan(&it.ID, &it.Code, &it.Kind, &it.Sheet, &it.NativeID, &it.VideoID, &it.Start, &it.End, &it.Proposed, &it.Cues, &flagged); err != nil {
			rows.Close()
			return nil, err
		}
		// flagged_by holds strings (run ids, judge lines); anything else reads as none.
		_ = json.Unmarshal(flagged, &it.FlaggedBy)
		d.Items = append(d.Items, it)
		natives = append(natives, it.NativeID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(`SELECT v.id, v.item_id, v.verdict, COALESCE(v.comment, ''), v.reviewer, v.start, v."end", v.decided_at
		  FROM prv_review_verdicts v JOIN prv_review_items i ON i.id = v.item_id
		 WHERE i.batch = $1 ORDER BY v.decided_at, v.id`, batch)
	if err != nil {
		return nil, fmt.Errorf("verdicts: %w", err)
	}
	for rows.Next() {
		var v verdict
		if err := rows.Scan(&v.ID, &v.ItemID, &v.Verdict, &v.Comment, &v.Reviewer, &v.Start, &v.End, &v.DecidedAt); err != nil {
			rows.Close()
			return nil, err
		}
		d.Verdicts = append(d.Verdicts, v)
		d.Watermark = max(d.Watermark, v.ID)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = tx.Query(`SELECT DISTINCT ON (native_id) native_id, value FROM prv_review_video_flags
		 WHERE flag = 'track_mismatch' AND native_id = ANY($1) ORDER BY native_id, created_at DESC, id DESC`, pq.Array(natives))
	if err != nil {
		return nil, fmt.Errorf("video flags: %w", err)
	}
	for rows.Next() {
		var n string
		var v bool
		if err := rows.Scan(&n, &v); err != nil {
			rows.Close()
			return nil, err
		}
		d.Track[n] = v
	}
	rows.Close()
	return d, rows.Err()
}
