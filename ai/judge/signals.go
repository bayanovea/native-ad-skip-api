// Package judge re-examines published AI rows (prv_ai_video_calculateds) on the
// user signals the product already stores: cheap rules first, the LLM judge
// only when the rules do not decide.
package judge

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/calculator"
)

// Counters are the signal counts a judgement sees and records (prv_ai_videos.judge_counters).
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
	New      Evidence    `json:"new"`
	ViewsMax *int64      `json:"views_max"`
	Requests int         `json:"requests"`
	AgeH     float64     `json:"age_h"`
	humans   []humanNote // the intervals behind HumanMarkups, for the LLM judge's request
}

// Evidence is the negative signals created after the baseline (per entry: the last judgement,
// or the human keep of that entry after it); only these make a judged video due again. Each is
// dated by a time that never moves back, so counts that shrink later (an entry removed on
// review, a vote changed back) can never hide a new one, as a count compared with a stored
// count can.
type Evidence struct {
	VotesDown          int `json:"votes_down"` // users' latest votes on an entry that are down and were cast after the baseline
	Undo               int `json:"undo"`
	ConflictingMarkups int `json:"conflicting_markups"`
	DurationRecut      int `json:"duration_recut"` // re-cuts beyond the count the last judgement recorded
}

func (e Evidence) negative() bool {
	return e.VotesDown > 0 || e.Undo > 0 || e.ConflictingMarkups > 0
}

// Entry is one AI segment of prv_ai_video_calculateds.data.
type Entry struct {
	CategoryID int    `json:"category_id"`
	Start      int    `json:"start"`
	End        int    `json:"end"`
	Source     string `json:"source,omitempty"` // "ai", or "review" once an assessor set the bounds
}

// EntryKey is an entry's bounds, by which review items and their verdicts find it.
type EntryKey struct{ Start, End int }

func (e Entry) key() EntryKey { return EntryKey{e.Start, e.End} }

// Video is one published AI row with its queue state.
type Video struct {
	VideoID       int
	NativeID      string
	Data          []byte // the row's data as stored; the queries read the entries' bounds from it
	Entries       []Entry
	PublishedAt   time.Time
	Duration      sql.NullInt64 // the AI row's videos.duration
	JudgedAt      sql.NullTime
	JudgeCounters []byte // the last judgement's counters
	ViewsMax      sql.NullInt64
	Requests      int
	LastSeenAt    time.Time
}

// entryBounds joins a signal table to the AI entries' exact bounds and, where the
// JSON has it, each entry's baseline (since). Every query that embeds it passes that JSON as $2.
const entryBounds = `jsonb_to_recordset($2::jsonb) AS e(category_id int, start int, "end" int, since timestamptz)`

// baseline is an AI entry with the time after which the evidence on it is new.
type baseline struct {
	Entry
	Since time.Time `json:"since"`
}

// collectSignals runs one query per signal, counting the rows created up to asOf
// (the tick's start) and, in New, the negative ones created after the entry's
// baseline since[i] (zero time for a first judgement: all of them); a conflicting
// markup belongs to no entry, so its baseline is the earliest. Every signal with
// bounds counts only the AI entries' exact (category_id, start, end), the key
// votes and events carry.
func collectSignals(db *sql.DB, v Video, categories map[int]string, since []time.Time, asOf time.Time) (Signals, error) {
	s := Signals{Requests: v.Requests, AgeH: asOf.Sub(v.PublishedAt).Hours()}
	if v.ViewsMax.Valid {
		s.ViewsMax = &v.ViewsMax.Int64
	}
	bs := make([]baseline, len(v.Entries))
	markupsSince := asOf
	for i, e := range v.Entries {
		bs[i] = baseline{Entry{CategoryID: e.CategoryID, Start: e.Start, End: e.End}, since[i]} // the queries take the bounds only
		if since[i].Before(markupsSince) {
			markupsSince = since[i]
		}
	}
	bounds, err := json.Marshal(bs)
	if err != nil {
		return s, err
	}
	if s.VotesUp, s.VotesDown, s.New.VotesDown, err = votes(db, v.VideoID, bounds, asOf); err != nil {
		return s, fmt.Errorf("votes: %w", err)
	}
	if s.Undo, s.New.Undo, err = events(db, "prv_events_interval_undo", v.NativeID, bounds, asOf); err != nil {
		return s, fmt.Errorf("undo: %w", err)
	}
	if s.Clicks, _, err = events(db, "prv_events_interval_click", v.NativeID, bounds, asOf); err != nil {
		return s, fmt.Errorf("clicks: %w", err)
	}
	if s.humans, err = humanMarkups(db, v, categories, asOf); err != nil {
		return s, fmt.Errorf("human markups: %w", err)
	}
	s.HumanMarkups = len(s.humans)
	for _, h := range s.humans {
		if h.Conflicting {
			s.ConflictingMarkups++
			if h.DatedAt.After(markupsSince) {
				s.New.ConflictingMarkups++
			}
		}
	}
	if s.DurationVariants, s.DurationRecut, err = durationVariants(db, v, asOf); err != nil {
		return s, fmt.Errorf("duration variants: %w", err)
	}
	// A row turns into a re-cut with a later request, which has no time of its own; the count only
	// grows (videos rows are never deleted, a NULL duration only gets filled), so the recorded one is
	// a sound watermark.
	s.New.DurationRecut = max(0, s.DurationRecut-storedRecut(v.JudgeCounters))
	return s, nil
}

// votes counts the users' latest votes on each AI entry that are up / down (the
// rating rule of lib/segment-rating.js), and the down ones cast after the entry's
// baseline. POST /vote keeps the row of a repeated vote, so a vote's time is when
// the user said it.
func votes(db *sql.DB, videoID int, bounds []byte, asOf time.Time) (up, down, newDown int, err error) {
	err = db.QueryRow(`SELECT COUNT(*) FILTER (WHERE vote > 0), COUNT(*) FILTER (WHERE vote < 0), COUNT(*) FILTER (WHERE vote < 0 AND "createdAt" > since)
		FROM (SELECT DISTINCT ON (vt.user_id, vt.category_id, vt.start, vt."end") vt.vote, vt."createdAt", e.since
			FROM votes vt JOIN `+entryBounds+` ON vt.category_id = e.category_id AND vt.start = e.start AND vt."end" = e."end"
			WHERE vt.video_id = $1 AND vt."createdAt" <= $3
			ORDER BY vt.user_id, vt.category_id, vt.start, vt."end", vt."createdAt" DESC, vt.id DESC) latest`,
		videoID, bounds, asOf).Scan(&up, &down, &newDown)
	return
}

// events counts undo / click events on the AI entries, and those after the entry's baseline; events carry the native_id, not the videos row.
func events(db *sql.DB, table, nativeID string, bounds []byte, asOf time.Time) (n, newN int, err error) {
	err = db.QueryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE ev."createdAt" > e.since) FROM `+table+` ev JOIN `+entryBounds+`
		ON ev.category_id = e.category_id AND ev.start = e.start AND ev."end" = e."end"
		WHERE ev.video_native_id = $1 AND ev."createdAt" <= $3`, nativeID, bounds, asOf).Scan(&n, &newN)
	return
}

// humanMarkups lists the live human intervals on the AI row's videos row posted
// since publish, each marked when it conflicts with the AI (see conflicts). An
// interval is dated by its last edit too (PUT /markups moves its bounds in place and
// touches every interval of the markup on a category change), not by
// markups."updatedAt", which every recalculation bumps.
func humanMarkups(db *sql.DB, v Video, categories map[int]string, asOf time.Time) ([]humanNote, error) {
	rows, err := db.Query(`SELECT m.category_id, i.start, i."end", COALESCE(u.rating, 0), GREATEST(m."createdAt", i."updatedAt") AS dated
		FROM markups m
		JOIN markup_time_intervals i ON i.markup_id = m.id AND i.deleted_at IS NULL
		LEFT JOIN users u ON u.id = m.internal_user_id
		WHERE m.video_id = $1 AND m.deleted_at IS NULL AND m."createdAt" >= $2 AND GREATEST(m."createdAt", i."updatedAt") <= $3`, v.VideoID, v.PublishedAt, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []humanNote
	for rows.Next() {
		var h humanInterval
		var dated time.Time
		if err := rows.Scan(&h.CategoryID, &h.Start, &h.End, &h.AuthorRating, &dated); err != nil {
			return nil, err
		}
		out = append(out, humanNote{h, conflicts(h, v.Entries, categories), dated})
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
	DatedAt     time.Time // its markup's creation or its own last edit, whichever is later
}

// conflicts: a human interval of a category the detector produces whose IoU is
// below 0.5 with every AI entry of that category, by an author not rated down.
// Intro / credits markups are no disagreement, the detector never marks them.
func conflicts(h humanInterval, entries []Entry, categories map[int]string) bool {
	if h.AuthorRating < 0 {
		return false
	}
	if c := categories[h.CategoryID]; c != detector.CategorySponsor && c != detector.CategorySelfPromotion {
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
func durationVariants(db *sql.DB, v Video, asOf time.Time) (variants, recut int, err error) {
	err = db.QueryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE "createdAt" > $3 AND "createdAt" < $4)
		FROM videos WHERE native_id = $1 AND id <> $2 AND ABS(duration - $5::int) > $6 AND "createdAt" <= $7`,
		v.NativeID, v.VideoID, v.PublishedAt, v.LastSeenAt, v.Duration, calculator.DurationTolerance, asOf).Scan(&variants, &recut)
	return
}

// storedRecut is duration_recut of prv_ai_videos.judge_counters; missing or unreadable is zero.
func storedRecut(stored []byte) int {
	var c Counters
	if json.Unmarshal(stored, &c) != nil {
		return 0
	}
	return c.DurationRecut
}

// entryKeeps maps the bounds of each AI entry whose latest review verdict keeps it and
// came after the last judgement to that verdict's time. An item refers to the entry at its
// effective bounds: those of its latest verdict that has bounds (an assessor moved the entry),
// else its own; a later verdict without bounds leaves the entry where it was moved
// (prv/repository/ai.js allKept matches the items the same way).
func entryKeeps(db *sql.DB, v Video) (map[EntryKey]time.Time, error) {
	return keepVerdicts(db, v.VideoID, v.Data, v.JudgedAt.Time)
}

// EntryKeepsAll is the bounds of the entries (JSON of the row's entries) whose latest ai-item
// verdict keeps them, whenever decided: the entries ai regate pins in the truth layer.
func EntryKeepsAll(q querier, videoID int, entries []byte) (map[EntryKey]time.Time, error) {
	return keepVerdicts(q, videoID, entries, time.Time{})
}

// querier is *sql.DB or *sql.Tx.
type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func keepVerdicts(q querier, videoID int, entries []byte, after time.Time) (map[EntryKey]time.Time, error) {
	rows, err := q.Query(`SELECT e.start, e."end", k.decided_at FROM `+entryBounds+`
		JOIN LATERAL (SELECT l.verdict, l.decided_at FROM prv_review_items i
			JOIN LATERAL (SELECT r.id, r.verdict, r.decided_at FROM prv_review_verdicts r WHERE r.item_id = i.id
				ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) l ON TRUE
			LEFT JOIN LATERAL (SELECT r.start, r."end" FROM prv_review_verdicts r WHERE r.item_id = i.id AND r.start IS NOT NULL
				ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) b ON TRUE
			WHERE i.kind = 'ai' AND i.video_id = $1 AND COALESCE(b.start, i.start) = e.start AND COALESCE(b."end", i."end") = e."end"
			ORDER BY l.decided_at DESC, l.id DESC LIMIT 1) k ON TRUE
		WHERE k.verdict IN ('sponsor', 'self_promotion') AND k.decided_at > $3`,
		videoID, entries, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keeps := map[EntryKey]time.Time{}
	for rows.Next() {
		var k EntryKey
		var at time.Time
		if err := rows.Scan(&k.Start, &k.End, &at); err != nil {
			return nil, err
		}
		keeps[k] = at
	}
	return keeps, rows.Err()
}

// parseEntries reads the bounds of the row's data.
func parseEntries(data []byte) ([]Entry, error) {
	var out []Entry
	err := json.Unmarshal(data, &out)
	return out, err
}
