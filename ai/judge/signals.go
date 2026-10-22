// Package judge re-examines published AI rows (prv_ai_video_calculateds) on the
// user signals the product already stores: cheap rules first, the LLM judge
// only when the rules do not decide.
package judge

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// durationTolerance is lib/duration-tolerance.js DURATION_TOLERANCE.
const durationTolerance = 2

// Counters are the signals whose movement since the last judgement makes a video
// due again (prv_ai_videos.judge_counters). Views, requests and age always move,
// so they are in Signals only.
type Counters struct {
	VotesUp            int `json:"votes_up"`
	VotesDown          int `json:"votes_down"`
	Undo               int `json:"undo"`
	Clicks             int `json:"clicks"`
	HumanMarkups       int `json:"human_markups"`
	ConflictingMarkups int `json:"conflicting_markups"`
	DurationVariants   int `json:"duration_variants"`
	// DurationRecut: videos rows off by more than the tolerance that appeared after
	// publish and were followed by a request for the native_id (the video was re-cut).
	DurationRecut int `json:"duration_recut"`
}

// Signals is what a judgement sees, stored in prv_ai_judgements.signals.
type Signals struct {
	Counters
	ViewsMax *int64      `json:"views_max"`
	Requests int         `json:"requests"`
	AgeH     float64     `json:"age_h"`
	humans   []humanNote // the intervals behind HumanMarkups, for the LLM judge's request
}

// Entry is one AI segment of prv_ai_video_calculateds.data.
type Entry struct {
	CategoryID int `json:"category_id"`
	Start      int `json:"start"`
	End        int `json:"end"`
}

// Video is one published AI row with its queue state.
type Video struct {
	VideoID       int
	NativeID      string
	Data          []byte // the row's data as stored; the queries read the entries' bounds from it
	Entries       []Entry
	PublishedAt   time.Time
	Duration      sql.NullInt64 // the AI row's videos.duration
	JudgedAt      sql.NullTime
	JudgeCounters []byte
	ViewsMax      sql.NullInt64
	Requests      int
	LastSeenAt    time.Time
}

// entryBounds joins a signal table to the AI entries' exact bounds.
const entryBounds = `jsonb_to_recordset($2::jsonb) AS e(category_id int, start int, "end" int)`

// collectSignals runs one query per signal; every signal with bounds counts only
// the AI entries' exact (category_id, start, end), the key votes and events carry.
func collectSignals(db *sql.DB, v Video, categories map[int]string, now time.Time) (Signals, error) {
	s := Signals{Requests: v.Requests, AgeH: now.Sub(v.PublishedAt).Hours()}
	if v.ViewsMax.Valid {
		s.ViewsMax = &v.ViewsMax.Int64
	}
	var err error
	if s.VotesUp, s.VotesDown, err = votes(db, v); err != nil {
		return s, fmt.Errorf("votes: %w", err)
	}
	if s.Undo, err = events(db, "prv_events_interval_undo", v); err != nil {
		return s, fmt.Errorf("undo: %w", err)
	}
	if s.Clicks, err = events(db, "prv_events_interval_click", v); err != nil {
		return s, fmt.Errorf("clicks: %w", err)
	}
	if s.humans, err = humanMarkups(db, v, categories); err != nil {
		return s, fmt.Errorf("human markups: %w", err)
	}
	s.HumanMarkups = len(s.humans)
	for _, h := range s.humans {
		if h.Conflicting {
			s.ConflictingMarkups++
		}
	}
	if s.DurationVariants, s.DurationRecut, err = durationVariants(db, v); err != nil {
		return s, fmt.Errorf("duration variants: %w", err)
	}
	return s, nil
}

// votes counts distinct users whose latest vote on an AI entry is up / down
// (the rating rule of lib/segment-rating.js).
func votes(db *sql.DB, v Video) (up, down int, err error) {
	err = db.QueryRow(`SELECT COUNT(DISTINCT user_id) FILTER (WHERE vote > 0), COUNT(DISTINCT user_id) FILTER (WHERE vote < 0)
		FROM (SELECT DISTINCT ON (vt.user_id, vt.category_id, vt.start, vt."end") vt.user_id, vt.vote
			FROM votes vt JOIN `+entryBounds+` ON vt.category_id = e.category_id AND vt.start = e.start AND vt."end" = e."end"
			WHERE vt.video_id = $1
			ORDER BY vt.user_id, vt.category_id, vt.start, vt."end", vt."createdAt" DESC, vt.id DESC) latest`,
		v.VideoID, v.Data).Scan(&up, &down)
	return
}

// events counts undo / click events on the AI entries; events carry the native_id, not the videos row.
func events(db *sql.DB, table string, v Video) (n int, err error) {
	err = db.QueryRow(`SELECT COUNT(*) FROM `+table+` ev JOIN `+entryBounds+`
		ON ev.category_id = e.category_id AND ev.start = e.start AND ev."end" = e."end"
		WHERE ev.video_native_id = $1`, v.NativeID, v.Data).Scan(&n)
	return
}

// humanMarkups lists the live human intervals on the AI row's videos row posted
// since publish, each marked when it conflicts with the AI (see conflicts).
func humanMarkups(db *sql.DB, v Video, categories map[int]string) ([]humanNote, error) {
	rows, err := db.Query(`SELECT m.category_id, i.start, i."end", COALESCE(u.rating, 0)
		FROM markups m
		JOIN markup_time_intervals i ON i.markup_id = m.id AND i.deleted_at IS NULL
		LEFT JOIN users u ON u.id = m.internal_user_id
		WHERE m.video_id = $1 AND m.deleted_at IS NULL AND m."createdAt" >= $2`, v.VideoID, v.PublishedAt)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []humanNote
	for rows.Next() {
		var h humanInterval
		if err := rows.Scan(&h.CategoryID, &h.Start, &h.End, &h.AuthorRating); err != nil {
			return nil, err
		}
		out = append(out, humanNote{h, conflicts(h, v.Entries, categories)})
	}
	return out, rows.Err()
}

type humanInterval struct {
	CategoryID   int
	Start, End   float64
	AuthorRating int
}

type humanNote struct {
	humanInterval
	Conflicting bool
}

// conflicts: a human interval of a category the detector produces whose IoU is
// below 0.5 with every AI entry of that category, by an author not rated down.
// Intro / credits markups are no disagreement, the detector never marks them.
func conflicts(h humanInterval, entries []Entry, categories map[int]string) bool {
	if h.AuthorRating < 0 {
		return false
	}
	if c := categories[h.CategoryID]; c != "sponsor" && c != "self_promotion" {
		return false
	}
	for _, e := range entries {
		if e.CategoryID == h.CategoryID && iou(h.Start, h.End, float64(e.Start), float64(e.End)) >= 0.5 {
			return false
		}
	}
	return true
}

func iou(s1, e1, s2, e2 float64) float64 {
	inter := min(e1, e2) - max(s1, s2)
	if inter <= 0 {
		return 0
	}
	return inter / (max(e1, e2) - min(s1, s2))
}

// durationVariants counts the native_id's other videos rows off the AI row's
// duration by more than the tolerance (as ai detect logs them), and among them
// the ones created after publish with a request for the native_id since: the GET
// path records no videos row, so a request after the row appeared is the
// closest fact to "the new cut is being watched".
func durationVariants(db *sql.DB, v Video) (variants, recut int, err error) {
	err = db.QueryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE "createdAt" > $3 AND "createdAt" < $4)
		FROM videos WHERE native_id = $1 AND id <> $2 AND ABS(duration - $5::int) > $6`,
		v.NativeID, v.VideoID, v.PublishedAt, v.LastSeenAt, v.Duration, durationTolerance).Scan(&variants, &recut)
	return
}

// parseEntries reads the bounds of the row's data.
func parseEntries(data []byte) ([]Entry, error) {
	var out []Entry
	err := json.Unmarshal(data, &out)
	return out, err
}
