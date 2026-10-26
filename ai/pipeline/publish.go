package pipeline

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/calculator"
)

// Entry is one detected segment, the shape of a video_calculateds.data entry
// plus confidence and source; publish adds the rating from the votes to the
// served ones. A hidden entry carries the reason it is not served.
type Entry struct {
	CategoryID int    `json:"category_id"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
	Confidence string `json:"confidence"`
	Source     string `json:"source"`
	Reason     string `json:"reason,omitempty"`
}

// Reasons of a hidden entry: below accepted() (the truth layer, no verdict yet),
// shorter than AI_MIN_SEGMENT_SECONDS (the serving filter), or not an ad on
// review (prv/repository/ai.js applyVerdict; no rule ever serves it again).
const (
	reasonConfidence = "confidence"
	reasonShort      = "short"
	reasonReview     = "review"
)

// accepted is the product threshold the held-out SCORE was measured with:
// sponsor from medium confidence, self-promotion only at high.
func accepted(p detector.Prediction) bool {
	switch p.Category {
	case detector.CategorySponsor:
		return p.Confidence == "high" || p.Confidence == "medium"
	case detector.CategorySelfPromotion:
		return p.Confidence == "high"
	}
	return false
}

// entries maps predictions to whole seconds inside the predicted span (start up,
// end down: a skip never cuts content the model did not mark, and votes match
// segments by integer bounds) and splits them into served and hidden.
func entries(preds []detector.Prediction, categories map[string]int, minSeconds int) (served, hidden []Entry) {
	served, hidden = []Entry{}, []Entry{}
	for _, p := range preds {
		start, end := int(math.Ceil(p.Start)), int(math.Floor(p.End))
		e := Entry{CategoryID: categories[p.Category], Start: start, End: end, Confidence: p.Confidence, Source: "ai"}
		switch {
		case !accepted(p):
			e.Reason = reasonConfidence
		case end-start < minSeconds:
			e.Reason = reasonShort
		default:
			served = append(served, e)
			continue
		}
		hidden = append(hidden, e)
	}
	return served, hidden
}

// loadCategories maps the detector's category names to markup_categories ids.
func loadCategories(db *sql.DB) (map[string]int, error) {
	rows, err := db.Query(`SELECT id, category FROM markup_categories`)
	if err != nil {
		return nil, fmt.Errorf("markup categories: %w", err)
	}
	defer rows.Close()
	m := map[string]int{}
	for rows.Next() {
		var id int
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		m[name] = id
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range []string{detector.CategorySponsor, detector.CategorySelfPromotion} {
		if _, ok := m[c]; !ok {
			return nil, fmt.Errorf("markup_categories has no %q", c)
		}
	}
	return m, nil
}

// publish writes the video's AI row: data is what is served, hidden the rest
// (no ratings: nothing there reaches a player). An empty data still marks the
// video done (serving treats it as no AI row). claimOne refuses a native_id that has one, so
// the conflict branch is a safety net, and it never serves a withdrawn row again.
// Each entry starts with the rating of the votes already on its exact bounds
// (one interval, one vote), read under the video_calculateds lock: the vote
// handlers take it before the AI row, so no vote on the video commits between
// this read and the row becoming visible.
func publish(tx *sql.Tx, videoID int, nativeID string, runID int64, data, hidden []Entry) error {
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	h, err := json.Marshal(hidden)
	if err != nil {
		return err
	}
	if err := lockVideoCalculated(tx, videoID); err != nil {
		return err
	}
	if b, err = calculator.WithVoteRatings(tx, videoID, b); err != nil {
		return fmt.Errorf("publish ratings: %w", err)
	}
	_, err = tx.Exec(`INSERT INTO prv_ai_video_calculateds (video_id, native_id, run_id, data, hidden, published_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
		ON CONFLICT (video_id) DO UPDATE SET native_id = EXCLUDED.native_id, run_id = EXCLUDED.run_id, data = EXCLUDED.data,
			hidden = EXCLUDED.hidden, published_at = NOW(), updated_at = NOW()`,
		videoID, nativeID, runID, b, h)
	if err != nil {
		return fmt.Errorf("publish: %w", err)
	}
	return nil
}

// lockVideoCalculated is lib/segment-rating.js lockVideoCalculated: a recalculation
// replaces the row, so a lock that waited for one finds none and reads once more.
func lockVideoCalculated(tx *sql.Tx, videoID int) error {
	for i := 0; i < 2; i++ {
		res, err := tx.Exec(`SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE`, videoID)
		if err != nil {
			return fmt.Errorf("lock video calculated: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil || n > 0 {
			return err
		}
	}
	return nil
}
