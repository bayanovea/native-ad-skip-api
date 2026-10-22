package judge

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/vtt"
)

// batchMax is the importer's --max-items default: a batch a reviewer finishes in one sitting.
const batchMax = 30

// addReviewItems sends the video's AI entries to /admin/review: one kind='ai' item
// per entry in today's sheet ai-judge-<date>, mirroring reviewRepository.insertItems
// and createBatch. An entry with an item still waiting for a verdict gets none, so a
// withdrawn row's other entries still reach a human. Returns the batch and the
// number of items, "" and 0 when every entry already waits.
func addReviewItems(tx *sql.Tx, v Video, j judgement, s Signals, cues []vtt.Cue, categories map[int]string, now time.Time) (string, int, error) {
	rows, err := tx.Query(`SELECT i.start, i."end" FROM prv_review_items i WHERE i.kind = 'ai' AND i.video_id = $1
		AND NOT EXISTS (SELECT 1 FROM prv_review_verdicts r WHERE r.item_id = i.id)`, v.VideoID)
	if err != nil {
		return "", 0, fmt.Errorf("open items: %w", err)
	}
	open := map[[2]int]bool{}
	for rows.Next() {
		var b [2]int
		if err := rows.Scan(&b[0], &b[1]); err != nil {
			rows.Close()
			return "", 0, fmt.Errorf("open items: %w", err)
		}
		open[b] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", 0, fmt.Errorf("open items: %w", err)
	}
	var todo []int
	for i, e := range v.Entries {
		if !open[[2]int{e.Start, e.End}] {
			todo = append(todo, i)
		}
	}
	if len(todo) == 0 {
		return "", 0, nil
	}
	sheet := "ai-judge-" + now.UTC().Format("2006-01-02")
	batch, err := reviewBatch(tx, sheet, len(todo))
	if err != nil {
		return "", 0, err
	}
	var last int
	if err := tx.QueryRow(`SELECT COALESCE(MAX(position), 0) FROM prv_review_items WHERE COALESCE(sheet, batch) = $1`, sheet).Scan(&last); err != nil {
		return "", 0, err
	}
	prv, err := provider.Lookup("prv")
	if err != nil {
		return "", 0, err
	}
	for n, i := range todo {
		e := v.Entries[i]
		flagged, err := json.Marshal(flaggedBy(j, s, i))
		if err != nil {
			return "", 0, err
		}
		pos := last + n + 1
		// The player opens 2 s early, as the sheets' links do (the page uses the link as is).
		if _, err := tx.Exec(`INSERT INTO prv_review_items
				(sheet, batch, item_code, position, native_id, start, "end", proposed, cues, link, flagged_by, kind, video_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ai', $12, CURRENT_TIMESTAMP)`,
			sheet, batch, fmt.Sprintf("A%d", pos), pos, v.NativeID, e.Start, e.End, categories[e.CategoryID],
			nullString(cueText(cues, float64(e.Start), float64(e.End), "\n")), prv.LinkAt(v.NativeID, e.Start-2), flagged, v.VideoID); err != nil {
			return "", 0, fmt.Errorf("review item: %w", err)
		}
	}
	return batch, len(todo), nil
}

// reviewBatch picks the sheet's newest part that nobody holds or has started and
// that has room for n more items, else registers a new part (<sheet>, then
// <sheet>-p2, …), so a reviewer's batch never grows under them.
func reviewBatch(tx *sql.Tx, sheet string, n int) (string, error) {
	var batch string
	err := tx.QueryRow(`SELECT b.batch FROM prv_review_batches b
		WHERE b.batch IN (SELECT batch FROM prv_review_items WHERE COALESCE(sheet, batch) = $1)
			AND b.locked_by IS NULL
			AND (SELECT COUNT(*) FROM prv_review_items i WHERE i.batch = b.batch) + $2 <= $3
			AND NOT EXISTS (SELECT 1 FROM prv_review_items i JOIN prv_review_verdicts r ON r.item_id = i.id WHERE i.batch = b.batch)
		ORDER BY b.created_at DESC, b.batch DESC LIMIT 1 FOR UPDATE OF b`, sheet, n, batchMax).Scan(&batch)
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
	if _, err := tx.Exec(`INSERT INTO prv_review_batches (batch) VALUES ($1) ON CONFLICT DO NOTHING`, batch); err != nil {
		return "", fmt.Errorf("review batch: %w", err)
	}
	return batch, nil
}

// flaggedBy is the item's flagged_by, a list of strings like the sheets' run ids
// (the page and the export read a list): the judgement, its negative counters and
// the LLM's keep for this entry. Blind until the item has a verdict.
func flaggedBy(j judgement, s Signals, entry int) []string {
	out := []string{fmt.Sprintf("judge %s by %s: %s", j.Decision, j.By, j.Reason)}
	c := s.Counters
	var counters []string
	for _, x := range []struct {
		name string
		n    int
	}{{"votes_down", c.VotesDown}, {"undo", c.Undo}, {"conflicting_markups", c.ConflictingMarkups}, {"votes_up", c.VotesUp}, {"clicks", c.Clicks}} {
		if x.n > 0 {
			counters = append(counters, fmt.Sprintf("%s=%d", x.name, x.n))
		}
	}
	if len(counters) > 0 {
		out = append(out, "signals: "+strings.Join(counters, " "))
	}
	if keep, ok := j.Keep[entry]; ok {
		out = append(out, fmt.Sprintf("keep: %v", keep))
	}
	return out
}

func nullString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
