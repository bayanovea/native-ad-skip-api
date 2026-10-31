// Package review writes kind='ai' items into the assessor review tables for the
// Go callers (ai judge, the second opinion of ai detect). It mirrors
// reviewRepository.insertItems, createBatch and openPart (prv/repository/review.js):
// a review-schema change updates both.
package review

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"odedohbest/video-calculate/ai/vtt"
)

// BatchMax is the importer's --max-items default: a batch a reviewer finishes in one sitting.
const BatchMax = 30

// Item is one AI entry sent to review.
type Item struct {
	NativeID   string
	VideoID    int
	Start, End int
	Proposed   string   // the entry's category name
	Cues       string   // the transcript over the entry, "" = none
	Link       string   // player link, 2 s before the start as the sheets' links
	FlaggedBy  []string // blind until decided
}

// Add puts the items into one part of sheet (Batch) with codes <prefix><position>,
// positions continuing the sheet's, and returns the part.
func Add(tx *sql.Tx, sheet, prefix, priority string, items []Item) (string, error) {
	batch, err := Batch(tx, sheet, len(items), priority)
	if err != nil {
		return "", err
	}
	var last int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM prv_review_items WHERE COALESCE(sheet, batch) = $1`, sheet).Scan(&last); err != nil {
		return "", err
	}
	for n, it := range items {
		flagged, err := json.Marshal(it.FlaggedBy)
		if err != nil {
			return "", err
		}
		pos := last + n + 1
		if _, err := tx.Exec(`INSERT INTO prv_review_items
				(sheet, batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by, kind, video_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ai', $12)`,
			sheet, batch, fmt.Sprintf("%s%d", prefix, pos), pos, it.NativeID, it.Start, it.End, it.Proposed,
			nullString(it.Cues), it.Link, flagged, it.VideoID); err != nil {
			return "", fmt.Errorf("review item: %w", err)
		}
	}
	return batch, nil
}

// Batch picks the sheet's newest part that nobody holds or has started and that
// has room for n more items, else registers a new part (<sheet>, then
// <sheet>-p2, …: the importer's names when a re-import adds a part to a sheet
// imported whole) with the priority, so a reviewer's batch never grows under them.
func Batch(tx *sql.Tx, sheet string, n int, priority string) (string, error) {
	var batch string
	err := tx.QueryRow(`SELECT b.batch FROM prv_review_batches b
		WHERE b.batch IN (SELECT batch FROM prv_review_items WHERE COALESCE(sheet, batch) = $1)
			AND b.locked_by IS NULL
			AND (SELECT COUNT(*) FROM prv_review_items i WHERE i.batch = b.batch) + $2 <= $3
			AND NOT EXISTS (SELECT 1 FROM prv_review_items i JOIN prv_review_verdicts r ON r.item_id = i.id WHERE i.batch = b.batch)
		ORDER BY b.created_at DESC, b.batch DESC LIMIT 1 FOR UPDATE OF b`, sheet, n, BatchMax).Scan(&batch)
	if err == nil {
		return batch, nil
	}
	if err != sql.ErrNoRows {
		return "", fmt.Errorf("review batch: %w", err)
	}
	var parts int
	if err := tx.QueryRow(`SELECT COUNT(DISTINCT batch) FROM prv_review_items WHERE COALESCE(sheet, batch) = $1`, sheet).Scan(&parts); err != nil {
		return "", err
	}
	batch = sheet
	if parts > 0 {
		batch = fmt.Sprintf("%s-p%d", sheet, parts+1)
	}
	if _, err := tx.Exec(`INSERT INTO prv_review_batches (batch, priority) VALUES ($1, $2) ON CONFLICT DO NOTHING`, batch, priority); err != nil {
		return "", fmt.Errorf("review batch: %w", err)
	}
	return batch, nil
}

// CueText joins the texts of the cues overlapping [from, to).
func CueText(cues []vtt.Cue, from, to float64, sep string) string {
	var parts []string
	for _, c := range cues {
		if c.End > from && c.Start < to {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, sep)
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
