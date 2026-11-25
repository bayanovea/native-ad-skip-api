package pipeline

import (
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/review"
)

func TestUsersConfigFromEnv(t *testing.T) {
	for _, c := range []struct {
		env     map[string]string
		want    UsersConfig
		errPart string
	}{
		{env: map[string]string{}, want: UsersConfig{GlueSeconds: 20, MinSegmentSeconds: 5}},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on"}, errPart: "AI_USER_SEGMENTS_SINCE"},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on", "AI_USER_SEGMENTS_SINCE": "27.11.2026"}, errPart: "AI_USER_SEGMENTS_SINCE"},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on", "AI_USER_SEGMENTS_SINCE": "2026-11-27"},
			want: UsersConfig{Enabled: true, Since: time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC), GlueSeconds: 20, MinSegmentSeconds: 5}},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on", "AI_USER_SEGMENTS_SINCE": "2026-11-27T10:30:00Z", "AI_USER_GLUE_SECONDS": "0", "AI_MIN_SEGMENT_SECONDS": "3"},
			want: UsersConfig{Enabled: true, Since: time.Date(2026, 11, 27, 10, 30, 0, 0, time.UTC), MinSegmentSeconds: 3}},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on", "AI_USER_SEGMENTS_SINCE": "2026-11-27", "AI_USER_GLUE_SECONDS": "abc"}, errPart: "AI_USER_GLUE_SECONDS"},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on", "AI_USER_SEGMENTS_SINCE": "2026-11-27", "AI_USER_GLUE_SECONDS": "-1"}, errPart: "AI_USER_GLUE_SECONDS"},
		{env: map[string]string{"AI_USER_SEGMENTS_ENABLED": "on", "AI_USER_SEGMENTS_SINCE": "2026-11-27", "AI_MIN_SEGMENT_SECONDS": "0"}, errPart: "AI_MIN_SEGMENT_SECONDS"},
		{env: map[string]string{"AI_USER_GLUE_SECONDS": "abc"}, want: UsersConfig{GlueSeconds: 20, MinSegmentSeconds: 5}}, // off: only clears
	} {
		for _, k := range []string{"AI_USER_SEGMENTS_ENABLED", "AI_USER_SEGMENTS_SINCE", "AI_USER_GLUE_SECONDS", "AI_MIN_SEGMENT_SECONDS"} {
			t.Setenv(k, c.env[k])
		}
		got, err := UsersConfigFromEnv()
		if c.errPart != "" {
			if err == nil || !strings.Contains(err.Error(), c.errPart) {
				t.Errorf("%v: got %v, want an error naming %s", c.env, err, c.errPart)
			}
			continue
		}
		if err != nil || !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: got %+v %v, want %+v", c.env, got, err, c.want)
		}
	}
}

const (
	cIntro   = 3
	cSponsor = 4
	cSelf    = 5
	cCredits = 6
)

var (
	userNames = map[int]string{cIntro: "intro", cSponsor: "sponsor", cSelf: "self_promotion", cCredits: "credits"}
	usersCfg  = UsersConfig{Enabled: true, Since: time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC), GlueSeconds: 20, MinSegmentSeconds: 5}
	fresh     = usersCfg.Since.Add(time.Hour)
)

// useg: a calculated segment by `authors` authors (u1, u2, …), the best rating `best`, dated `at`.
func useg(id int64, cat, start, end, authors, best int, at time.Time) userSegment {
	a := map[string]bool{}
	for i := 1; i <= authors; i++ {
		a[fmt.Sprintf("user %d-%d", id, i)] = true
	}
	return userSegment{id: id, categoryID: cat, start: start, end: end, authors: a, best: best, newest: at}
}

func ai(cat, start, end int) Entry {
	return Entry{CategoryID: cat, Start: start, End: end, Confidence: "high", Source: "ai"}
}

func usr(cat, start, end int) Entry {
	return Entry{CategoryID: cat, Start: start, End: end, Source: sourceUser}
}

func glued(e Entry) Entry { e.Reason = reasonGlued; return e }

func hid(e Entry, reason string) Entry { e.Reason = reason; return e }

func urow(data []Entry, hidden ...Entry) userRow {
	return userRow{videoID: 7, nativeID: "-1_456000001", data: data, hidden: append([]Entry{}, hidden...)}
}

// uitem: an ai item of the row; user = in an ai-user sheet; eff = its effective bounds (nil: its own).
func uitem(user bool, start, end int, verdict string, eff ...int) userItem {
	it := userItem{ai: true, userSheet: user, start: float64(start), end: float64(end), effStart: float64(start), effEnd: float64(end), verdict: verdict}
	if len(eff) == 2 {
		it.effStart, it.effEnd = float64(eff[0]), float64(eff[1])
	}
	if verdict != "" {
		it.decidedAt = fresh
	}
	return it
}

func bounds(items []review.Item) [][2]int {
	var out [][2]int
	for _, it := range items {
		out = append(out, [2]int{it.Start, it.End})
	}
	return out
}

func TestPlanScenarios(t *testing.T) {
	sp := ai(cSponsor, 219, 292)
	for _, c := range []struct {
		name      string
		row       userRow
		segs      []userSegment
		items     []userItem
		cfg       *UsersConfig
		data      []Entry
		hidden    []Entry
		add       [][2]int
		flagged   string // the second flagged_by line of the first item
		unchanged bool
	}{
		{name: "a missed ad far from the AI's is shown with an item",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 1453, 1490, 1, 0, fresh)},
			data: []Entry{sp, usr(cSponsor, 1453, 1490)}, add: [][2]int{{1453, 1490}}, flagged: "shown"},
		{name: "a +16 s tail is glued, no item",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh)},
			data: []Entry{usr(cSponsor, 219, 308)}, hidden: []Entry{glued(sp)}},
		{name: "a small gap is glued with it",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 295, 310, 1, 0, fresh)},
			data: []Entry{usr(cSponsor, 219, 310)}, hidden: []Entry{glued(sp)}},
		{name: "another category is never glued",
			row: urow([]Entry{ai(cSelf, 219, 292)}), segs: []userSegment{useg(1, cSponsor, 292, 308, 1, 0, fresh)},
			data: []Entry{ai(cSelf, 219, 292), usr(cSponsor, 292, 308)}, add: [][2]int{{292, 308}}, flagged: "shown"},
		{name: "limit zero holds the tail",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh)}, cfg: &UsersConfig{Enabled: true, Since: usersCfg.Since, MinSegmentSeconds: 5},
			data: []Entry{sp}, add: [][2]int{{219, 308}}, flagged: "held: overlaps sponsor 219-292"},
		{name: "the user's ad is much longer: held at its own bounds and the AI entry",
			row: urow([]Entry{ai(cSponsor, 17, 24)}), segs: []userSegment{useg(1, cSponsor, 0, 55, 1, 0, fresh)},
			data: []Entry{ai(cSponsor, 17, 24)}, add: [][2]int{{0, 55}}, flagged: "held: overlaps sponsor 17-24"},
		{name: "a partial overlap is held at the union",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 285, 334, 1, 0, fresh)},
			data: []Entry{sp}, add: [][2]int{{219, 334}}, flagged: "held: overlaps sponsor 219-292"},
		{name: "another category underneath: held at the segment's bounds",
			row: urow([]Entry{ai(cSelf, 357, 370)}), segs: []userSegment{useg(1, cSponsor, 360, 437, 1, 0, fresh)},
			data: []Entry{ai(cSelf, 357, 370)}, add: [][2]int{{360, 437}}, flagged: "held: overlaps self_promotion 357-370"},
		{name: "mostly covered: the AI's edges stay",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 225, 300, 1, 0, fresh)}, unchanged: true},
		{name: "a kept entry is never glued: held",
			row: urow([]Entry{sp}), segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh)}, items: []userItem{uitem(false, 219, 292, "sponsor")},
			data: []Entry{sp}, add: [][2]int{{219, 308}}, flagged: "held: overlaps sponsor 219-292"},
		{name: "a review entry is never glued either",
			row: urow([]Entry{{CategoryID: cSponsor, Start: 219, End: 292, Source: "review"}}), segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh)},
			data: []Entry{{CategoryID: cSponsor, Start: 219, End: 292, Source: "review"}}, add: [][2]int{{219, 308}}, flagged: "held: overlaps sponsor 219-292"},
		{name: "a keep arriving while glued serves the model entry and holds the segment",
			row: urow([]Entry{usr(cSponsor, 219, 308)}, glued(sp)), segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh)},
			items: []userItem{uitem(false, 219, 292, "sponsor")}, data: []Entry{sp}, add: [][2]int{{219, 308}}, flagged: "held: overlaps sponsor 219-292"},
		{name: "the user deletes the markup: un-glued",
			row: urow([]Entry{usr(cSponsor, 219, 308)}, glued(sp)), data: []Entry{sp}},
		{name: "kept at smaller bounds: the segment stays closed",
			row:  urow([]Entry{ai(cSponsor, 1000, 1030), {CategoryID: cSponsor, Start: 100, End: 160, Source: "review"}}),
			segs: []userSegment{useg(1, cSponsor, 0, 960, 1, 0, fresh)}, items: []userItem{uitem(true, 0, 960, "sponsor", 100, 160)}, unchanged: true},
		{name: "a not_ad on the stretch closes it",
			row:  urow([]Entry{ai(cSponsor, 400, 430)}, hid(ai(cSponsor, 100, 130), reasonReview)),
			segs: []userSegment{useg(1, cSponsor, 98, 131, 1, 0, fresh)}, items: []userItem{uitem(false, 100, 130, "not_ad")}, unchanged: true},
		{name: "a not_ad on its own item closes a shown segment",
			row:  urow([]Entry{sp}, hid(usr(cSponsor, 1453, 1490), reasonReview)),
			segs: []userSegment{useg(1, cSponsor, 1453, 1490, 1, 0, fresh)}, items: []userItem{uitem(true, 1453, 1490, "not_ad")}, unchanged: true},
		{name: "two overlapping user segments: the one with more authors, the other waits",
			row:  urow([]Entry{sp}),
			segs: []userSegment{useg(1, cSelf, 520, 580, 1, 0, fresh), useg(2, cSponsor, 500, 560, 2, 0, fresh)},
			data: []Entry{sp, usr(cSponsor, 500, 560)}, add: [][2]int{{500, 560}}, flagged: "shown"},
		{name: "an intro is shown as it is, old or not, no item; one over an AI entry is not",
			row:  urow([]Entry{ai(cSponsor, 10, 40), ai(cSponsor, 300, 330)}),
			segs: []userSegment{useg(1, cIntro, 0, 30, 1, 0, fresh.AddDate(-1, 0, 0)), useg(2, cCredits, 580, 600, 1, 0, fresh.AddDate(-1, 0, 0))},
			data: []Entry{ai(cSponsor, 10, 40), ai(cSponsor, 300, 330), usr(cCredits, 580, 600)}},
		{name: "an old markup, a rated-down author and a short segment give nothing",
			row: urow([]Entry{sp}),
			segs: []userSegment{useg(1, cSponsor, 1000, 1040, 1, 0, usersCfg.Since.Add(-time.Second)), useg(2, cSponsor, 1100, 1140, 1, -1, fresh),
				useg(3, cSponsor, 1200, 1204, 1, 0, fresh), useg(4, cCredits, 1300, 1320, 1, -1, fresh)},
			unchanged: true},
		{name: "a withdrawn row loses its user entries and its glue",
			row: func() userRow {
				r := urow([]Entry{usr(cSponsor, 219, 308), usr(cIntro, 0, 20)}, glued(sp))
				r.withdrawn = true
				return r
			}(),
			segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh), useg(2, cIntro, 0, 20, 1, 0, fresh)}, data: []Entry{sp}},
		{name: "a row with no model entry gets nothing",
			row: urow([]Entry{}, hid(sp, reasonReview)), segs: []userSegment{useg(1, cIntro, 0, 20, 1, 0, fresh)}, unchanged: true},
		{name: "switched off: user entries removed, glue undone, review entries stay",
			row:  urow([]Entry{usr(cSponsor, 219, 308), {CategoryID: cSponsor, Start: 500, End: 540, Source: "review"}, usr(cSponsor, 1453, 1490)}, glued(sp)),
			segs: []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh)}, cfg: &UsersConfig{},
			data: []Entry{sp, {CategoryID: cSponsor, Start: 500, End: 540, Source: "review"}}},
		{name: "while its item waits a shown entry stays at the item's bounds",
			row:  urow([]Entry{sp, usr(cSponsor, 1453, 1490)}),
			segs: []userSegment{useg(1, cSponsor, 1454, 1490, 2, 0, fresh)}, items: []userItem{uitem(true, 1453, 1490, "")}, unchanged: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg := usersCfg
			if c.cfg != nil {
				cfg = *c.cfg
			}
			p := plan(c.row, c.segs, c.items, userNames, cfg)
			if c.unchanged {
				if p.changed || len(p.add) > 0 {
					t.Fatalf("want no change, got %+v / %+v add %v", p.data, p.hidden, bounds(p.add))
				}
				return
			}
			if c.hidden == nil {
				c.hidden = []Entry{}
			}
			if !sameEntries(p.data, c.data) || !sameEntries(p.hidden, c.hidden) ||
				!reflect.DeepEqual(bounds(p.add), c.add) {
				t.Fatalf("got %+v / %+v add %v\nwant %+v / %+v add %v", p.data, p.hidden, bounds(p.add), c.data, c.hidden, c.add)
			}
			if c.flagged != "" && (len(p.add[0].FlaggedBy) != 2 || p.add[0].FlaggedBy[1] != c.flagged || p.add[0].Proposed == "") {
				t.Fatalf("flagged_by %q (proposed %q), want second line %q", p.add[0].FlaggedBy, p.add[0].Proposed, c.flagged)
			}
		})
	}
}

// The plan's own result is stable: a second tick changes nothing and adds no item.
func TestPlanSecondTickChangesNothing(t *testing.T) {
	sp := ai(cSponsor, 219, 292)
	row := urow([]Entry{sp, ai(cSponsor, 600, 640)})
	segs := []userSegment{useg(1, cSponsor, 290, 308, 1, 0, fresh), useg(2, cSponsor, 1453, 1490, 1, 0, fresh), useg(3, cSponsor, 620, 700, 1, 0, fresh)}
	p := plan(row, segs, nil, userNames, usersCfg)
	if p.shown != 1 || p.glued != 1 || p.held != 1 || p.removed != 0 || len(p.add) != 2 {
		t.Fatalf("first tick: %+v", p)
	}
	var items []userItem
	for _, it := range p.add {
		items = append(items, uitem(true, it.Start, it.End, ""))
	}
	again := plan(userRow{videoID: 7, nativeID: row.nativeID, data: p.data, hidden: p.hidden}, segs, items, userNames, usersCfg)
	if again.changed || len(again.add) > 0 {
		t.Fatalf("second tick: %+v", again)
	}
	if got := p.add[0].FlaggedBy[0]; got != "user markup: 1 authors, best rating 0" {
		t.Fatalf("first flagged_by line %q", got)
	}
}

func TestClusterCountsNearDuplicatesOnce(t *testing.T) {
	a := useg(1, cSponsor, 571, 722, 3, 0, fresh)
	b := useg(2, cSponsor, 573, 728, 2, 5, fresh.Add(time.Hour))
	other := useg(3, cSelf, 571, 722, 1, 0, fresh)
	got := cluster([]userSegment{b, a, other})
	if len(got) != 2 || got[0].id != 1 || got[0].start != 571 || got[0].end != 722 || len(got[0].authors) != 5 ||
		got[0].best != 5 || !got[0].newest.Equal(fresh.Add(time.Hour)) || got[1].id != 3 {
		t.Fatalf("got %+v", got)
	}
	p := plan(urow([]Entry{ai(cSponsor, 10, 40)}), []userSegment{a, b}, nil, userNames, usersCfg)
	if len(p.add) != 1 || len(p.data) != 2 {
		t.Fatalf("near-duplicates: one entry and one item, got %+v add %v", p.data, bounds(p.add))
	}
}

// syncRow takes video_calculateds, then the AI row, reads segments and items again, and
// writes nothing when the wanted state is the row's.
func TestSyncRowLockOrderAndNoWrite(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"video_id", "native_id", "run_id", "data", "hidden", "withdrawn"}).
			AddRow(7, "-1_456000001", int64(11), []byte(`[{"category_id":4,"start":219,"end":292,"confidence":"high","source":"ai","rating":2}]`), []byte(`[]`), false))
	mock.ExpectQuery("FROM prv_calculated_segments s").WillReturnRows(sqlmock.NewRows(
		[]string{"video_id", "id", "category_id", "start", "end", "markup_id", "user_id", "rating", "dated"}).
		AddRow(7, int64(1), cSponsor, 225, 300, int64(9), int64(5), 0, fresh))
	mock.ExpectQuery("FROM prv_review_items i").WillReturnRows(sqlmock.NewRows(
		[]string{"native_id", "ai", "video_id", "user", "start", "end", "eff_start", "eff_end", "verdict", "decided_at", "verdict_id"}))
	mock.ExpectRollback()
	u := &usersRun{cfg: usersCfg, db: db, prv: testPrv, names: userNames, now: fresh}
	if ok, err := u.syncRow(7); ok || err != nil {
		t.Fatalf("got %v %v", ok, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// A shown segment: the row is written with the votes' ratings, then the U item goes into
// today's ai-user sheet (urgent) with the run's cues and the link 2 s before.
func TestSyncRowWritesTheEntryThenTheItem(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"video_id", "native_id", "run_id", "data", "hidden", "withdrawn"}).
			AddRow(7, "-1_456000001", int64(11), []byte(`[{"category_id":4,"start":219,"end":292,"confidence":"high","source":"ai"}]`), []byte(`[]`), false))
	mock.ExpectQuery("FROM prv_calculated_segments s").WillReturnRows(sqlmock.NewRows(
		[]string{"video_id", "id", "category_id", "start", "end", "markup_id", "user_id", "rating", "dated"}).
		AddRow(7, int64(1), cSponsor, 1453, 1490, int64(9), nil, 0, fresh))
	mock.ExpectQuery("FROM prv_review_items i").WillReturnRows(sqlmock.NewRows(
		[]string{"native_id", "ai", "video_id", "user", "start", "end", "eff_start", "eff_end", "verdict", "decided_at", "verdict_id"}))
	mock.ExpectQuery("FROM votes").WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}).AddRow(cSponsor, 1453.0, 1490.0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3")).
		WithArgs(7, []byte(`[{"category_id":4,"confidence":"high","end":292,"source":"ai","start":219},{"category_id":4,"end":1490,"rating":1,"source":"user","start":1453}]`), []byte(`[]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT transcript FROM prv_ai_runs WHERE id = $1")).WithArgs(int64(11)).
		WillReturnRows(sqlmock.NewRows([]string{"transcript"}).AddRow([]byte(`{"meta":{},"cues":[{"start":1450,"end":1460,"text":"промокод"}]}`)))
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WithArgs("ai-user-2026-11-27", 1, review.BatchMax).WillReturnRows(sqlmock.NewRows([]string{"batch"}))
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_batches").WithArgs("ai-user-2026-11-27", "urgent").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-user-2026-11-27", "ai-user-2026-11-27", "U1", 1, "-1_456000001", 1453, 1490, "sponsor", "промокод",
			"https://example.invalid/video-1_456000001?t=24m11s", []byte(`["user markup: 1 authors, best rating 0","shown"]`), 7).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectCommit()
	u := &usersRun{cfg: usersCfg, db: db, prv: testPrv, names: userNames, now: fresh}
	if ok, err := u.syncRow(7); !ok || err != nil {
		t.Fatalf("got %v %v", ok, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
