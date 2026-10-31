package judge

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/review"
	"odedohbest/video-calculate/ai/vtt"
)

// addReviewItems sends the video's AI entries to /admin/review: one kind='ai' item
// per entry in today's sheet ai-judge-<date> (ai/review). An entry with an item still waiting for a verdict gets none, so a
// withdrawn row's other entries still reach a human. Returns the batch and the
// number of items, "" and 0 when every entry already waits.
func addReviewItems(tx *sql.Tx, prv provider.Provider, v Video, j judgement, s Signals, cues []vtt.Cue, categories map[int]string, now time.Time) (string, int, error) {
	// Matched on the item's own bounds, not its effective ones: an open item has no verdict, so no
	// assessor has moved its entry.
	rows, err := tx.Query(`SELECT i.start, i."end" FROM prv_review_items i WHERE i.kind = 'ai' AND i.video_id = $1
		AND NOT EXISTS (SELECT 1 FROM prv_review_verdicts r WHERE r.item_id = i.id)`, v.VideoID)
	if err != nil {
		return "", 0, fmt.Errorf("open items: %w", err)
	}
	open := map[EntryKey]bool{}
	for rows.Next() {
		var k EntryKey
		if err := rows.Scan(&k.Start, &k.End); err != nil {
			rows.Close()
			return "", 0, fmt.Errorf("open items: %w", err)
		}
		open[k] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return "", 0, fmt.Errorf("open items: %w", err)
	}
	var todo []int
	for i, e := range v.Entries {
		if !open[e.key()] {
			todo = append(todo, i)
		}
	}
	if len(todo) == 0 {
		return "", 0, nil
	}
	items := make([]review.Item, len(todo))
	for n, i := range todo {
		e := v.Entries[i]
		items[n] = review.Item{NativeID: v.NativeID, VideoID: v.VideoID, Start: e.Start, End: e.End, Proposed: categories[e.CategoryID],
			Cues: review.CueText(cues, float64(e.Start), float64(e.End), "\n"), Link: prv.LinkAt(v.NativeID, e.Start-2), FlaggedBy: flaggedBy(j, s, i)}
	}
	// Judge batches are urgent: their videos are served (or withdrawn) on prod right now.
	batch, err := review.Add(tx, "ai-judge-"+now.UTC().Format("2006-01-02"), "A", "urgent", items)
	if err != nil {
		return "", 0, err
	}
	return batch, len(todo), nil
}

// flaggedBy is the item's flagged_by, a list of strings like the sheets' run ids
// (the page and the export read a list): the judgement, its signal counters and
// the LLM's keep for this entry. Blind until the item has a verdict. judgeReason in
// prv/routes/admin-review.js parses the first line's format.
func flaggedBy(j judgement, s Signals, entry int) []string {
	out := []string{fmt.Sprintf("judge %s by %s: %s", j.Decision, j.By, j.Reason)}
	c := s.Counters
	var counters []string
	for _, x := range []struct {
		name string
		n    int
	}{{"votes_down", c.VotesDown}, {"undo", c.Undo}, {"conflicting_markups", c.ConflictingMarkups}, {"duration_recut", c.DurationRecut}, {"votes_up", c.VotesUp}, {"clicks", c.Clicks}} {
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
