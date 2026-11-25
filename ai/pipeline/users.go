package pipeline

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"reflect"
	"sort"
	"strconv"
	"time"

	"github.com/lib/pq"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/platform"
	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/review"
	"odedohbest/video-calculate/ai/vtt"
	"odedohbest/video-calculate/calculator"
)

// UsersConfig is the ai users pass's environment, read apart from Config so a bad
// value never stops ai detect.
type UsersConfig struct {
	Enabled           bool      // AI_USER_SEGMENTS_ENABLED=on
	Since             time.Time // AI_USER_SEGMENTS_SINCE: an ad segment counts only with a markup created or edited from then on
	GlueSeconds       int       // AI_USER_GLUE_SECONDS: how much a glue may add to the model's entries
	MinSegmentSeconds int       // AI_MIN_SEGMENT_SECONDS: an ad segment's least length
}

// UsersConfigFromEnv reads the variables only when the pass is switched on: switched off,
// a tick only removes what the pass wrote, whatever the other values are.
func UsersConfigFromEnv() (UsersConfig, error) {
	c := UsersConfig{Enabled: os.Getenv("AI_USER_SEGMENTS_ENABLED") == "on", GlueSeconds: 20, MinSegmentSeconds: 5}
	if !c.Enabled {
		return c, nil
	}
	s := os.Getenv("AI_USER_SEGMENTS_SINCE")
	since, err := time.Parse(time.RFC3339, s)
	if err != nil {
		since, err = time.ParseInLocation("2006-01-02", s, time.UTC)
	}
	if err != nil {
		return c, fmt.Errorf("AI_USER_SEGMENTS_SINCE must be an RFC 3339 instant or a YYYY-MM-DD date (UTC), got %q", s)
	}
	c.Since = since
	for _, v := range []struct {
		name string
		min  int
		dst  *int
	}{{"AI_USER_GLUE_SECONDS", 0, &c.GlueSeconds}, {"AI_MIN_SEGMENT_SECONDS", 1, &c.MinSegmentSeconds}} {
		if s := os.Getenv(v.name); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < v.min {
				return c, fmt.Errorf("%s must be an integer of at least %d, got %q", v.name, v.min, s)
			}
			*v.dst = n
		}
	}
	return c, nil
}

// userSegment is a prv_calculated_segments row with what its live markups say: their
// authors (user ids, or the markup for one without a user), the best author rating and
// the newest markup creation or interval edit.
type userSegment struct {
	id         int64
	categoryID int
	start, end int
	authors    map[string]bool
	best       int
	newest     time.Time
}

// before is the order segments are placed in and a cluster's representative is chosen by:
// more authors, then the best rating, the newest markup, the lowest id.
func (a userSegment) before(b userSegment) bool {
	switch {
	case len(a.authors) != len(b.authors):
		return len(a.authors) > len(b.authors)
	case a.best != b.best:
		return a.best > b.best
	case !a.newest.Equal(b.newest):
		return a.newest.After(b.newest)
	}
	return a.id < b.id
}

// cluster counts near-duplicates once: segments of one category with IoU ≥ 0.5 (neighbouring
// 3-s buckets of one ad) are one, at the bounds of the first by before(), with the authors and
// the newest markup of all of them. The result is in before() order.
func cluster(segs []userSegment) []userSegment {
	parent := make([]int, len(segs))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	for i := range segs {
		for j := i + 1; j < len(segs); j++ {
			if segs[i].categoryID == segs[j].categoryID && iou(float64(segs[i].start), float64(segs[i].end), float64(segs[j].start), float64(segs[j].end)) >= 0.5 {
				parent[find(j)] = find(i)
			}
		}
	}
	groups := map[int][]userSegment{}
	for i, s := range segs {
		groups[find(i)] = append(groups[find(i)], s)
	}
	out := make([]userSegment, 0, len(groups))
	for _, g := range groups {
		sort.Slice(g, func(i, j int) bool { return g[i].before(g[j]) })
		c := g[0]
		c.authors = map[string]bool{}
		for _, s := range g {
			for a := range s.authors {
				c.authors[a] = true
			}
			c.best = max(c.best, s.best)
			if s.newest.After(c.newest) {
				c.newest = s.newest
			}
		}
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].before(out[j]) })
	return out
}

// userItem is a review item of the video's native_id with its latest verdict ("" = undecided)
// and its effective bounds (those of its latest verdict with bounds, else its own).
type userItem struct {
	aiVideo    int64 // video_id of a kind = 'ai' item, 0 for a sheet item
	ai         bool  // an ai item of this row (markRow)
	userSheet  bool  // a user segment's item (sheet ai-user-*) of this row
	start, end float64
	effStart   float64
	effEnd     float64
	verdict    string
	decidedAt  time.Time
	verdictID  int64
}

func isKeep(verdict string) bool {
	return verdict == detector.CategorySponsor || verdict == detector.CategorySelfPromotion
}

// pinned: an assessor looked at the entry, so nothing extends it without one: its bounds were
// set on review, or its latest ai-item verdict is a keep (judge.EntryKeepsAll's rule: of the
// decided items at the entry's bounds, the one decided last).
func pinned(e Entry, items []userItem) bool {
	if e.Source == sourceReview {
		return true
	}
	var last *userItem
	for i, it := range items {
		if it.ai && it.verdict != "" && it.effStart == float64(e.Start) && it.effEnd == float64(e.End) &&
			(last == nil || it.decidedAt.After(last.decidedAt) || it.decidedAt.Equal(last.decidedAt) && it.verdictID > last.verdictID) {
			last = &items[i]
		}
	}
	return last != nil && isKeep(last.verdict)
}

// ownItem is the user segment's item: a U item of the row whose own bounds have IoU ≥ 0.5
// with the bounds it would be sent at; a decided one first.
func ownItem(items []userItem, start, end int) *userItem {
	var found *userItem
	for i, it := range items {
		if it.ai && it.userSheet && iou(it.start, it.end, float64(start), float64(end)) >= 0.5 && (found == nil || found.verdict == "") {
			found = &items[i]
		}
	}
	return found
}

// rejected: an item of the video (any kind) answered not_ad / unclear on the segment's stretch.
func rejected(items []userItem, s userSegment) bool {
	for _, it := range items {
		if (it.verdict == "not_ad" || it.verdict == "unclear") && iou(it.effStart, it.effEnd, float64(s.start), float64(s.end)) >= 0.5 {
			return true
		}
	}
	return false
}

// userRow is the AI row as the pass reads it.
type userRow struct {
	videoID      int
	nativeID     string
	runID        sql.NullInt64
	data, hidden []Entry
	withdrawn    bool
}

// userPlan is a row's wanted state: data and hidden to write when changed, the U items to add,
// and the counts for the log.
type userPlan struct {
	data, hidden                []Entry
	add                         []review.Item
	changed                     bool
	shown, glued, held, removed int
}

// plan derives the row's wanted state from the users' segments (clustered here) and the
// review items of its native_id, with no memory of earlier ticks (design decisions 4–7 of
// openspec change ai-user-segments). The model's entries are read as if nothing were
// glued: data without user entries plus the glued hidden entries no served entry overlaps.
// Without one of them, on a withdrawn row or switched off, no user entry is wanted. Ad
// segments go first, then intro and credits, each placed entry counting as served for
// the next, so the result never overlaps.
func plan(row userRow, segs []userSegment, items []userItem, names map[int]string, cfg UsersConfig) userPlan {
	var model, hidden []Entry
	for _, e := range row.data {
		if e.Source != sourceUser {
			model = append(model, e)
		}
	}
	for _, e := range row.hidden {
		if e.Reason == reasonGlued && !overlapsAny(e, model) {
			e.Reason = ""
			model = append(model, e)
			continue
		}
		hidden = append(hidden, e)
	}
	served := append([]Entry{}, model...)
	p := userPlan{}
	user := func(cat, start, end int) {
		served = append(served, Entry{CategoryID: cat, Start: start, End: end, Source: sourceUser})
	}
	if cfg.Enabled && !row.withdrawn && len(model) > 0 {
		clustered := cluster(segs)
		for _, u := range clustered {
			name := names[u.categoryID]
			if name != detector.CategorySponsor && name != detector.CategorySelfPromotion {
				continue
			}
			if u.best < 0 || u.end-u.start < cfg.MinSegmentSeconds || u.newest.Before(cfg.Since) || rejected(items, u) {
				continue
			}
			covered := 0
			for _, e := range model {
				covered += max(0, min(e.End, u.end)-max(e.Start, u.start))
			}
			if 2*covered >= u.end-u.start {
				continue // the AI's edges stay
			}
			if start, end, n, ok := glue(u, served, items, cfg.GlueSeconds); ok {
				if own := ownItem(items, start, end); own != nil && own.verdict != "" {
					continue
				}
				var rest []Entry
				for _, e := range served {
					if n[e] {
						e.Reason, e.Rating = reasonGlued, 0
						hidden = append(hidden, e)
					} else {
						rest = append(rest, e)
					}
				}
				served = rest
				user(u.categoryID, start, end)
				continue
			}
			flagged := []string{fmt.Sprintf("user markup: %d authors, best rating %d", len(u.authors), u.best)}
			if overlapsAny(Entry{Start: u.start, End: u.end}, served) {
				start, end := u.start, u.end
				var first *Entry
				for i, e := range served {
					if e.Source == sourceUser || !(e.Start < u.end && u.start < e.End) {
						continue
					}
					if first == nil {
						first = &served[i]
					}
					if e.CategoryID == u.categoryID {
						start, end = min(start, e.Start), max(end, e.End)
					}
				}
				if first == nil || ownItem(items, start, end) != nil {
					continue // over another user segment it waits; with an item, decided or not, it stands
				}
				p.add = append(p.add, userReviewItem(row, u, start, end, names,
					append(flagged, fmt.Sprintf("held: overlaps %s %d-%d", names[first.CategoryID], first.Start, first.End))))
				p.held++
				continue
			}
			// While its item waits, the entry stays at the item's bounds, where the verdict looks for it.
			start, end := u.start, u.end
			own := ownItem(items, start, end)
			if own != nil && own.verdict != "" {
				continue
			}
			if own != nil {
				start, end = int(own.start), int(own.end)
				if overlapsAny(Entry{Start: start, End: end}, served) {
					continue
				}
			} else {
				p.add = append(p.add, userReviewItem(row, u, start, end, names, append(flagged, "shown")))
			}
			user(u.categoryID, start, end)
		}
		for _, u := range clustered {
			if name := names[u.categoryID]; name != "intro" && name != "credits" || u.best < 0 {
				continue
			}
			if !overlapsAny(Entry{Start: u.start, End: u.end}, served) {
				user(u.categoryID, u.start, u.end)
			}
		}
	}
	byStart := func(s []Entry) []Entry {
		sort.SliceStable(s, func(i, j int) bool { return s[i].Start < s[j].Start })
		return s
	}
	p.data, p.hidden = byStart(append([]Entry{}, served...)), byStart(append([]Entry{}, hidden...))
	p.changed = !sameEntries(p.data, row.data) || !sameEntries(p.hidden, row.hidden)

	old := map[Entry]bool{}
	for _, e := range row.data {
		if e.Source == sourceUser {
			e.Rating = 0
			old[e] = true
		}
	}
	gluedOver := func(e Entry) bool {
		for _, h := range p.hidden {
			if h.Reason == reasonGlued && h.Start >= e.Start && h.End <= e.End {
				return true
			}
		}
		return false
	}
	for _, e := range p.data {
		if e.Source != sourceUser {
			continue
		}
		e.Rating = 0
		if old[e] {
			delete(old, e)
		} else if gluedOver(e) {
			p.glued++
		} else {
			p.shown++
		}
	}
	p.removed = len(old)
	return p
}

// glue: the same-category model entries (unpinned, served) that the segment overlaps or lies
// within limit seconds of, when the union adds at most limit seconds to them and overlaps
// nothing else served. A limit of 0 never glues: the union then adds the segment's own part.
func glue(u userSegment, served []Entry, items []userItem, limit int) (start, end int, n map[Entry]bool, ok bool) {
	n = map[Entry]bool{}
	start, end = u.start, u.end
	sum := 0
	for _, e := range served {
		if e.Source == sourceUser || e.CategoryID != u.categoryID || pinned(e, items) ||
			max(e.Start-u.end, u.start-e.End) > limit {
			continue
		}
		n[e] = true
		sum += e.End - e.Start
		start, end = min(start, e.Start), max(end, e.End)
	}
	if len(n) == 0 || end-start-sum > limit {
		return 0, 0, nil, false
	}
	for _, e := range served {
		if !n[e] && e.Start < end && start < e.End {
			return 0, 0, nil, false
		}
	}
	return start, end, n, true
}

func userReviewItem(row userRow, u userSegment, start, end int, names map[int]string, flagged []string) review.Item {
	return review.Item{NativeID: row.nativeID, VideoID: row.videoID, Start: start, End: end, Proposed: names[u.categoryID], FlaggedBy: flagged}
}

// sameEntries compares entry lists without their ratings, which the vote handlers keep.
func sameEntries(a, b []Entry) bool {
	norm := func(s []Entry) []Entry {
		out := make([]Entry, len(s))
		for i, e := range s {
			e.Rating = 0
			out[i] = e
		}
		sort.SliceStable(out, func(i, j int) bool { return out[i].Start < out[j].Start })
		return out
	}
	return reflect.DeepEqual(norm(a), norm(b))
}

// Users is one tick of the ai users pass. Switched on, it brings every handled AI row to the
// state plan() derives and writes the ai_users heartbeat (a success when its own queries ran);
// switched off, it derives the same with no user segment over the rows holding a user or a
// glued entry, then clears that heartbeat.
func Users(cfg UsersConfig) error {
	db := calculator.ConnectDb()
	defer db.Close()
	var prv provider.Provider
	if cfg.Enabled {
		var err error
		if prv, err = platform.FromEnv(); err != nil {
			return err
		}
	}
	u := &usersRun{cfg: cfg, db: db, prv: prv, now: time.Now()}
	if !cfg.Enabled {
		rows, changed, failed, err := u.tick()
		if err == nil && failed > 0 {
			err = fmt.Errorf("%d of %d rows failed", failed, rows)
		}
		if err == nil {
			log.Printf("ai users: off, %d rows cleared", changed)
		}
		// A switched-off pass never leaves a heartbeat to age into CalculatorStale; a failure is in the log.
		return errors.Join(err, calculator.ClearHeartbeat(db, "ai_users"))
	}
	rows, changed, failed, err := u.tick()
	if herr := calculator.WriteHeartbeatStatus(db, "ai_users", failed, err == nil); herr != nil {
		log.Printf("Heartbeat write failed: %v", herr)
		return errors.Join(fmt.Errorf("heartbeat: %w", herr), err)
	}
	if err != nil {
		return err
	}
	log.Printf("ai users: %d rows, %d changed, %d failed", rows, changed, failed)
	if failed > 0 {
		return fmt.Errorf("%d of %d rows failed", failed, rows)
	}
	return nil
}

type usersRun struct {
	cfg   UsersConfig
	db    *sql.DB
	prv   provider.Provider
	names map[int]string
	now   time.Time
}

// tick reads the candidate rows, their segments and items outside any lock, and syncs under
// the locks only a row whose wanted state differs.
func (u *usersRun) tick() (rows, changed, failed int, err error) {
	cats, err := loadCategories(u.db)
	if err != nil {
		return 0, 0, 0, err
	}
	u.names = map[int]string{}
	for name, id := range cats {
		u.names[id] = name
	}
	cands, err := candidateRows(u.db, u.cfg.Enabled)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("candidate rows: %w", err)
	}
	var ids []int64
	var natives []string
	for _, r := range cands {
		ids = append(ids, int64(r.videoID))
		natives = append(natives, r.nativeID)
	}
	segs, items := map[int][]userSegment{}, map[string][]userItem{}
	if u.cfg.Enabled {
		if segs, err = loadSegments(u.db, ids); err != nil {
			return 0, 0, 0, fmt.Errorf("segments: %w", err)
		}
		if items, err = loadItems(u.db, natives); err != nil {
			return 0, 0, 0, fmt.Errorf("items: %w", err)
		}
	}
	for _, r := range cands {
		p := plan(r, segs[r.videoID], markRow(items[r.nativeID], r.videoID), u.names, u.cfg)
		if !p.changed && len(p.add) == 0 {
			continue
		}
		ok, err := u.syncRow(r.videoID)
		if err != nil {
			log.Printf("ai users: video %d failed: %v", r.videoID, err)
			failed++
			continue
		}
		if ok {
			changed++
		}
	}
	return len(cands), changed, failed, nil
}

// candidateRows: the rows holding a user or a glued entry (in any state: a withdrawn one
// loses them) and, switched on, the published rows whose video has users' segments.
func candidateRows(q rowsQuerier, enabled bool) ([]userRow, error) {
	rows, err := q.Query(`SELECT video_id, native_id, run_id, data, hidden, withdrawn_at IS NOT NULL FROM prv_ai_video_calculateds a
		WHERE a.data @> '[{"source":"user"}]' OR a.hidden @> '[{"reason":"glued"}]'
			OR ($1 AND a.withdrawn_at IS NULL AND EXISTS (SELECT 1 FROM prv_calculated_segments s WHERE s.video_id = a.video_id))
		ORDER BY video_id`, enabled)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []userRow
	for rows.Next() {
		r, err := scanUserRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

type scanner interface{ Scan(dest ...any) error }

func scanUserRow(s scanner) (userRow, error) {
	var r userRow
	var data, hidden []byte
	if err := s.Scan(&r.videoID, &r.nativeID, &r.runID, &data, &hidden, &r.withdrawn); err != nil {
		return r, err
	}
	return r, errors.Join(json.Unmarshal(data, &r.data), json.Unmarshal(hidden, &r.hidden))
}

// rowsQuerier is *sql.DB or *sql.Tx.
type rowsQuerier interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

// loadSegments: the videos' calculated segments with their live markups' authors, ratings and
// dates. A markup is dated by its creation or its intervals' last edit, whichever is later (the
// judge's dating: PUT /markups edits intervals in place; markups."updatedAt" moves on every
// recalculation). A segment whose markups are all deleted is left out.
func loadSegments(q rowsQuerier, videoIDs []int64) (map[int][]userSegment, error) {
	rows, err := q.Query(`SELECT s.video_id, s.id, s.category_id, s.start, s."end", m.id, m.internal_user_id, COALESCE(u.rating, 0),
			GREATEST(m."createdAt", MAX(i."updatedAt"))
		FROM prv_calculated_segments s
		JOIN prv_calculated_segment_markups sm ON sm.segment_id = s.id
		JOIN markups m ON m.id = sm.markup_id AND m.deleted_at IS NULL
		JOIN markup_time_intervals i ON i.markup_id = m.id AND i.deleted_at IS NULL
		LEFT JOIN users u ON u.id = m.internal_user_id
		WHERE s.video_id = ANY($1)
		GROUP BY s.video_id, s.id, s.category_id, s.start, s."end", m.id, m.internal_user_id, u.rating, m."createdAt"
		ORDER BY s.video_id, s.id`, pq.Array(videoIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int][]userSegment{}
	for rows.Next() {
		var videoID, rating int
		var markupID int64
		var userID sql.NullInt64
		var dated time.Time
		var s userSegment
		if err := rows.Scan(&videoID, &s.id, &s.categoryID, &s.start, &s.end, &markupID, &userID, &rating, &dated); err != nil {
			return nil, err
		}
		author := fmt.Sprintf("markup %d", markupID)
		if userID.Valid {
			author = fmt.Sprintf("user %d", userID.Int64)
		}
		list := out[videoID]
		if n := len(list); n > 0 && list[n-1].id == s.id {
			last := &list[n-1]
			last.authors[author] = true
			last.best = max(last.best, rating)
			if dated.After(last.newest) {
				last.newest = dated
			}
			continue
		}
		s.authors, s.best, s.newest = map[string]bool{author: true}, rating, dated
		out[videoID] = append(list, s)
	}
	return out, rows.Err()
}

// loadItems: every review item of the native_ids (any kind: a sheet's not_ad closes a segment
// too) with its latest verdict and effective bounds, as prv/repository/review.js effectiveOf.
// ai and userSheet are set per row by markRow.
func loadItems(q rowsQuerier, nativeIDs []string) (map[string][]userItem, error) {
	rows, err := q.Query(`SELECT i.native_id, i.kind = 'ai', i.video_id, COALESCE(i.sheet, i.batch) LIKE 'ai-user-%',
			i.start::float8, i."end"::float8, COALESCE(b.start, i.start)::float8, COALESCE(b."end", i."end")::float8,
			COALESCE(l.verdict, ''), l.decided_at, COALESCE(l.id, 0)
		FROM prv_review_items i
		LEFT JOIN LATERAL (SELECT r.id, r.verdict, r.decided_at FROM prv_review_verdicts r WHERE r.item_id = i.id
			ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) l ON TRUE
		LEFT JOIN LATERAL (SELECT r.start, r."end" FROM prv_review_verdicts r WHERE r.item_id = i.id AND r.start IS NOT NULL
			ORDER BY r.decided_at DESC, r.id DESC LIMIT 1) b ON TRUE
		WHERE i.native_id = ANY($1)
		ORDER BY i.id`, pq.Array(nativeIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]userItem{}
	for rows.Next() {
		var nativeID string
		var ai bool
		var videoID sql.NullInt64
		var decided sql.NullTime
		var it userItem
		if err := rows.Scan(&nativeID, &ai, &videoID, &it.userSheet, &it.start, &it.end, &it.effStart, &it.effEnd,
			&it.verdict, &decided, &it.verdictID); err != nil {
			return nil, err
		}
		if ai {
			it.aiVideo = videoID.Int64
		}
		it.decidedAt = decided.Time
		out[nativeID] = append(out[nativeID], it)
	}
	return out, rows.Err()
}

// markRow sets ai and userSheet for the items of the row's video: the native_id may have AI
// rows of other cuts, whose items are not this row's.
func markRow(items []userItem, videoID int) []userItem {
	out := make([]userItem, len(items))
	for i, it := range items {
		it.ai = it.aiVideo != 0 && it.aiVideo == int64(videoID)
		it.userSheet = it.userSheet && it.ai
		out[i] = it
	}
	return out
}

// syncRow brings one row to its wanted state in one transaction: video_calculateds, then the
// AI row FOR UPDATE (the vote handlers' order; the calculator takes the first lock too, so the
// segments read after it are committed ones), then the segments and items are read again and
// plan() derives anew; the row is written only when it differs, the U items last (review.Add
// takes a batch row: the judge's order). Returns whether anything was written.
func (u *usersRun) syncRow(videoID int) (bool, error) {
	tx, err := u.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if err := lockVideoCalculated(tx, videoID); err != nil {
		return false, err
	}
	r, err := scanUserRow(tx.QueryRow(`SELECT video_id, native_id, run_id, data, hidden, withdrawn_at IS NOT NULL
		FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE`, videoID))
	if err != nil {
		return false, fmt.Errorf("lock AI row: %w", err)
	}
	var segs []userSegment
	var items []userItem
	if u.cfg.Enabled {
		all, err := loadSegments(tx, []int64{int64(videoID)})
		if err != nil {
			return false, fmt.Errorf("segments: %w", err)
		}
		byNative, err := loadItems(tx, []string{r.nativeID})
		if err != nil {
			return false, fmt.Errorf("items: %w", err)
		}
		segs, items = all[videoID], markRow(byNative[r.nativeID], videoID)
	}
	p := plan(r, segs, items, u.names, u.cfg)
	if !p.changed && len(p.add) == 0 {
		return false, nil
	}
	if p.changed {
		dataB, err := json.Marshal(p.data)
		if err != nil {
			return false, err
		}
		if dataB, err = calculator.WithVoteRatings(tx, videoID, dataB); err != nil {
			return false, fmt.Errorf("ratings: %w", err)
		}
		hiddenB, err := json.Marshal(p.hidden)
		if err != nil {
			return false, err
		}
		if _, err := tx.Exec(`UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3, updated_at = NOW() WHERE video_id = $1`,
			videoID, dataB, hiddenB); err != nil {
			return false, err
		}
	}
	if len(p.add) > 0 {
		cues, err := runTranscript(tx, r.runID)
		if err != nil {
			return false, err
		}
		for i := range p.add {
			it := &p.add[i]
			it.Cues = review.CueText(cues, float64(it.Start), float64(it.End), "\n")
			it.Link = u.prv.LinkAt(r.nativeID, it.Start-2)
		}
		if _, err := review.Add(tx, "ai-user-"+u.now.UTC().Format("2006-01-02"), "U", "urgent", p.add); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	log.Printf("ai users: video %d: +%d shown, %d glued, %d held, -%d removed", videoID, p.shown, p.glued, p.held, p.removed)
	return true, nil
}

// runTranscript is the cues of the row's run, none without a run or a readable transcript.
func runTranscript(tx *sql.Tx, runID sql.NullInt64) ([]vtt.Cue, error) {
	if !runID.Valid {
		return nil, nil
	}
	var raw []byte
	err := tx.QueryRow(`SELECT transcript FROM prv_ai_runs WHERE id = $1`, runID.Int64).Scan(&raw)
	if err == sql.ErrNoRows || raw == nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("transcript: %w", err)
	}
	var st storedTranscript
	if json.Unmarshal(raw, &st) != nil {
		return nil, nil
	}
	return st.Cues, nil
}
