package pipeline

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"

	"odedohbest/video-calculate/ai/detector"
)

// Entry is one published segment, the shape of a video_calculateds.data entry
// plus confidence and source; rating is added by votes later.
type Entry struct {
	CategoryID int    `json:"category_id"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
	Confidence string `json:"confidence"`
	Source     string `json:"source"`
}

// minSegmentSeconds is the eval's scoring floor: shorter predictions are noise.
const minSegmentSeconds = 5

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

// entries filters predictions by the thresholds and maps them to whole seconds
// inside the predicted span (start up, end down): a skip never cuts content the
// model did not mark, and votes match segments by integer bounds.
func entries(preds []detector.Prediction, categories map[string]int) []Entry {
	out := []Entry{}
	for _, p := range preds {
		start, end := int(math.Ceil(p.Start)), int(math.Floor(p.End))
		if !accepted(p) || end-start < minSegmentSeconds {
			continue
		}
		out = append(out, Entry{CategoryID: categories[p.Category], Start: start, End: end, Confidence: p.Confidence, Source: "ai"})
	}
	return out
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

// publish writes the video's AI row; an empty data still marks the video done
// (serving treats it as no AI row). claimOne refuses a native_id that has one, so
// the conflict branch is a safety net, and it never serves a withdrawn row again.
func publish(tx *sql.Tx, videoID int, nativeID string, runID int64, data []Entry) error {
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`INSERT INTO prv_ai_video_calculateds (video_id, native_id, run_id, data, published_at, updated_at)
		VALUES ($1, $2, $3, $4, NOW(), NOW())
		ON CONFLICT (video_id) DO UPDATE SET native_id = EXCLUDED.native_id, run_id = EXCLUDED.run_id, data = EXCLUDED.data,
			published_at = NOW(), updated_at = NOW()`,
		videoID, nativeID, runID, b)
	if err != nil {
		return fmt.Errorf("publish: %w", err)
	}
	return nil
}
