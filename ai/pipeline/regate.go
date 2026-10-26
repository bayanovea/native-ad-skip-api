package pipeline

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sort"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/judge"
	"odedohbest/video-calculate/calculator"
)

// rowEntry is an entry as stored in prv_ai_video_calculateds, with the rating a served one carries.
type rowEntry struct {
	Entry
	Rating int `json:"rating,omitempty"`
}

// Regate moves every AI row's entries between data and hidden by the current rules
// (accepted(), AI_MIN_SEGMENT_SECONDS), withdrawn rows included: run by hand after a
// rule change. With backfill it first fills an empty hidden from the row's run.
func Regate(cfg Config, backfill bool) error {
	db := calculator.ConnectDb()
	defer db.Close()
	cats, err := loadCategories(db)
	if err != nil {
		return err
	}
	ids, err := aiRowIDs(db)
	if err != nil {
		return err
	}
	changed, failed := 0, 0
	for _, id := range ids {
		ok, err := regateRow(db, cats, cfg.MinSegmentSeconds, id, backfill)
		if err != nil {
			log.Printf("ai regate: %d failed: %v", id, err)
			failed++
			continue
		}
		if ok {
			changed++
		}
	}
	log.Printf("ai regate: %d rows, %d changed, %d failed (min %d s)", len(ids), changed, failed, cfg.MinSegmentSeconds)
	if failed > 0 {
		return fmt.Errorf("%d of %d rows failed", failed, len(ids))
	}
	return nil
}

func aiRowIDs(db *sql.DB) ([]int, error) {
	rows, err := db.Query(`SELECT video_id FROM prv_ai_video_calculateds ORDER BY video_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// regateRow regates one row in its own transaction, under the vote handlers' lock
// order (video_calculateds, then the AI row); it writes only when an entry moved.
func regateRow(db *sql.DB, cats map[string]int, minSeconds, videoID int, backfill bool) (bool, error) {
	tx, err := db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err := lockVideoCalculated(tx, videoID); err != nil {
		return false, err
	}
	var dataB, hiddenB []byte
	var runID sql.NullInt64
	if err := tx.QueryRow(`SELECT data, hidden, run_id FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE`, videoID).
		Scan(&dataB, &hiddenB, &runID); err != nil {
		return false, fmt.Errorf("lock AI row: %w", err)
	}
	var data, hidden []rowEntry
	if err := errors.Join(json.Unmarshal(dataB, &data), json.Unmarshal(hiddenB, &hidden)); err != nil {
		return false, err
	}
	added := 0
	if backfill && len(hidden) == 0 && runID.Valid {
		if hidden, err = backfillHidden(tx, cats, minSeconds, runID.Int64, data); err != nil {
			return false, err
		}
		added = len(hidden)
	}

	all, err := json.Marshal(append(append([]rowEntry{}, data...), hidden...))
	if err != nil {
		return false, err
	}
	pinned, err := judge.EntryKeepsAll(tx, videoID, all)
	if err != nil {
		return false, fmt.Errorf("keep verdicts: %w", err)
	}
	names := map[int]string{}
	for name, id := range cats {
		names[id] = name
	}
	served, hid, in, out, moved := place(data, hidden, pinned, names, minSeconds)
	if !moved && added == 0 {
		return false, nil
	}

	if dataB, err = json.Marshal(served); err != nil {
		return false, err
	}
	if in > 0 {
		if dataB, err = calculator.WithVoteRatings(tx, videoID, dataB); err != nil {
			return false, fmt.Errorf("ratings: %w", err)
		}
	}
	if hiddenB, err = json.Marshal(hid); err != nil {
		return false, err
	}
	if _, err := tx.Exec(`UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3, updated_at = NOW() WHERE video_id = $1`,
		videoID, dataB, hiddenB); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	log.Printf("ai regate: %d %d served, %d hidden (+%d −%d), %d backfilled", videoID, len(served), len(hid), in, out, added)
	return true, nil
}

// place puts each entry where the rules say: a review entry stays hidden, a pinned one
// (latest verdict a keep) skips the confidence rule, the length rule applies to all,
// confidence before short as in entries(). in / out count the entries entering /
// leaving data, moved also a hidden entry whose reason changed. An entry leaving data
// drops its rating: hidden ratings are not maintained.
func place(data, hidden []rowEntry, pinned map[[2]int]bool, names map[int]string, minSeconds int) (served, hid []rowEntry, in, out int, moved bool) {
	served, hid = []rowEntry{}, []rowEntry{}
	for i, e := range append(append([]rowEntry{}, data...), hidden...) {
		wasServed := i < len(data)
		if !wasServed && e.Reason == reasonReview {
			hid = append(hid, e)
			continue
		}
		reason := ""
		switch {
		case !pinned[[2]int{e.Start, e.End}] &&
			!accepted(detector.Prediction{Segment: detector.Segment{Category: names[e.CategoryID], Confidence: e.Confidence}}):
			reason = reasonConfidence
		case e.End-e.Start < minSeconds:
			reason = reasonShort
		}
		switch {
		case reason == "":
			if !wasServed {
				in++
				e.Reason = ""
			}
			served = append(served, e)
			continue
		case wasServed:
			out++
			e.Rating = 0
		case e.Reason != reason:
			moved = true
		}
		e.Reason = reason
		hid = append(hid, e)
	}
	for _, s := range [][]rowEntry{served, hid} {
		sort.SliceStable(s, func(i, j int) bool { return s[i].Start < s[j].Start })
	}
	return served, hid, in, out, moved || in+out > 0
}

// backfillHidden rebuilds the hidden entries of a row published before the column existed,
// from its run the way finish() does: the segments that fail the current rules and are
// not in data. An entry a verdict removed from data passed the rules, so none comes back.
// A run without an object raw_output or a transcript gives none.
func backfillHidden(tx *sql.Tx, cats map[string]int, minSeconds int, runID int64, data []rowEntry) ([]rowEntry, error) {
	var raw, tr []byte
	err := tx.QueryRow(`SELECT raw_output, transcript FROM prv_ai_runs
		WHERE id = $1 AND jsonb_typeof(raw_output) = 'object' AND transcript IS NOT NULL`, runID).Scan(&raw, &tr)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("run %d: %w", runID, err)
	}
	out, err := detector.ParseOutput(string(raw))
	if err != nil {
		return nil, fmt.Errorf("run %d: %w", runID, err)
	}
	var st storedTranscript
	if err := json.Unmarshal(tr, &st); err != nil {
		return nil, fmt.Errorf("run %d transcript: %w", runID, err)
	}
	units := requestFormat.Apply(st.Cues)
	if err := detector.Validate(units, out); err != nil {
		return nil, fmt.Errorf("run %d: %w", runID, err)
	}
	inData := map[[3]int]bool{}
	for _, e := range data {
		inData[[3]int{e.CategoryID, e.Start, e.End}] = true
	}
	_, hidden := entries(detector.Resolve(units, out), cats, minSeconds)
	var add []rowEntry
	for _, e := range hidden {
		if !inData[[3]int{e.CategoryID, e.Start, e.End}] {
			add = append(add, rowEntry{Entry: e})
		}
	}
	return add, nil
}
