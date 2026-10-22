package judge

import (
	"database/sql"
	"encoding/json"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

var (
	published = time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	testVideo = Video{
		VideoID:     7,
		NativeID:    "-1_456000001",
		Data:        []byte(`[{"category_id":2,"start":30,"end":70,"confidence":"high","source":"ai"}]`),
		Entries:     []Entry{{CategoryID: 2, Start: 30, End: 70}},
		PublishedAt: published,
		Duration:    sql.NullInt64{Int64: 600, Valid: true},
		ViewsMax:    sql.NullInt64{Int64: 25000, Valid: true},
		Requests:    12,
		LastSeenAt:  published.Add(30 * time.Hour),
	}
	testCategories = map[int]string{1: "intro", 2: "sponsor", 3: "self_promotion", 4: "credits"}
	asOf           = published.Add(36 * time.Hour)
)

func newMock(t *testing.T) (*sql.DB, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
		db.Close()
	})
	return db, mock
}

var since = published.Add(25 * time.Hour)

// testBounds: testVideo's entry with its baseline, as collectSignals passes it to the queries.
func testBounds(since time.Time) []byte {
	b, _ := json.Marshal([]baseline{{testVideo.Entries[0], since}})
	return b
}

func TestVotesCountsEachUsersLatestVoteOnEachEntry(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)`+regexp.QuoteMeta(`COUNT(*) FILTER (WHERE vote > 0), COUNT(*) FILTER (WHERE vote < 0), COUNT(*) FILTER (WHERE vote < 0 AND "createdAt" > since)`)+`.*`+
		regexp.QuoteMeta(`DISTINCT ON (vt.user_id, vt.category_id, vt.start, vt."end") vt.vote, vt."createdAt", e.since`)+`.*`+
		regexp.QuoteMeta(`jsonb_to_recordset($2::jsonb) AS e(category_id int, start int, "end" int, since timestamptz)`)+`.*`+
		regexp.QuoteMeta(`WHERE vt.video_id = $1 AND vt."createdAt" <= $3`)+`.*`+
		regexp.QuoteMeta(`vt."createdAt" DESC, vt.id DESC`)).
		WithArgs(7, testBounds(since), asOf).
		WillReturnRows(sqlmock.NewRows([]string{"up", "down", "new_down"}).AddRow(3, 2, 1))
	up, down, newDown, err := votes(db, 7, testBounds(since), asOf)
	if err != nil || up != 3 || down != 2 || newDown != 1 {
		t.Fatalf("got %d %d %d %v", up, down, newDown, err)
	}
}

func TestEventsMatchTheEntriesByNativeID(t *testing.T) {
	db, mock := newMock(t)
	for table, n := range map[string]int{"prv_events_interval_undo": 2, "prv_events_interval_click": 5} {
		mock.ExpectQuery(`(?s)`+regexp.QuoteMeta(`SELECT COUNT(*), COUNT(*) FILTER (WHERE ev."createdAt" > e.since) FROM `+table+" ev JOIN jsonb_to_recordset($2::jsonb)")+
			`.*`+regexp.QuoteMeta(`WHERE ev.video_native_id = $1 AND ev."createdAt" <= $3`)).
			WithArgs("-1_456000001", testBounds(since), asOf).
			WillReturnRows(sqlmock.NewRows([]string{"count", "new"}).AddRow(n, 1))
		got, newN, err := events(db, table, "-1_456000001", testBounds(since), asOf)
		if err != nil || got != n || newN != 1 {
			t.Fatalf("%s: got %d %d %v", table, got, newN, err)
		}
	}
}

func TestHumanMarkupsSincePublish(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)FROM markups m.*LEFT JOIN users u ON u.id = m.internal_user_id.*`+
		regexp.QuoteMeta(`m.deleted_at IS NULL AND m."createdAt" >= $2 AND GREATEST(m."createdAt", i."updatedAt") <= $3`)).
		WithArgs(7, published, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating", "created"}).
			AddRow(2, 32.0, 68.0, 0, published).    // agrees with the AI entry
			AddRow(2, 100.0, 120.0, 5, published).  // a sponsor the AI does not have
			AddRow(2, 200.0, 230.0, -3, published). // the same, by an author rated down
			AddRow(1, 0.0, 15.0, 0, published))     // intro: the detector never marks it
	hs, err := humanMarkups(db, testVideo, testCategories, asOf)
	if err != nil || len(hs) != 4 {
		t.Fatalf("got %+v %v", hs, err)
	}
	for i, want := range []bool{false, true, false, false} {
		if hs[i].Conflicting != want {
			t.Errorf("interval %d: conflicting %v, want %v", i, hs[i].Conflicting, want)
		}
	}
}

func TestDurationVariantsAndRecut(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)`+regexp.QuoteMeta(`COUNT(*) FILTER (WHERE "createdAt" > $3 AND "createdAt" < $4)`)+`.*`+
		regexp.QuoteMeta(`native_id = $1 AND id <> $2 AND ABS(duration - $5::int) > $6 AND "createdAt" <= $7`)).
		WithArgs("-1_456000001", 7, published, testVideo.LastSeenAt, testVideo.Duration, 2, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(2, 1))
	variants, recut, err := durationVariants(db, testVideo, asOf)
	if err != nil || variants != 2 || recut != 1 {
		t.Fatalf("got %d %d %v", variants, recut, err)
	}
}

func TestCollectSignals(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery("FROM votes").WillReturnRows(sqlmock.NewRows([]string{"up", "down", "new_down"}).AddRow(1, 2, 1))
	mock.ExpectQuery("prv_events_interval_undo").WillReturnRows(sqlmock.NewRows([]string{"count", "new"}).AddRow(1, 0))
	mock.ExpectQuery("prv_events_interval_click").WillReturnRows(sqlmock.NewRows([]string{"count", "new"}).AddRow(4, 4))
	mock.ExpectQuery("FROM markups").WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating", "created"}).
		AddRow(2, 100.0, 120.0, 0, since).                  // conflicting, at the baseline: not new
		AddRow(2, 300.0, 320.0, 0, since.Add(time.Second)). // conflicting, after it
		AddRow(2, 30.0, 70.0, 0, since.Add(time.Second)))   // agrees
	mock.ExpectQuery("FROM videos").WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(3, 2))
	v := testVideo
	v.JudgeCounters = []byte(`{"duration_recut":1}`) // re-cuts only ever grow: one of the two is new
	s, err := collectSignals(db, v, testCategories, []time.Time{since}, asOf)
	if err != nil {
		t.Fatal(err)
	}
	want := Counters{VotesUp: 1, VotesDown: 2, Undo: 1, Clicks: 4, HumanMarkups: 3, ConflictingMarkups: 2, DurationVariants: 3, DurationRecut: 2}
	if s.Counters != want || s.New != (Evidence{VotesDown: 1, ConflictingMarkups: 1, DurationRecut: 1}) || *s.ViewsMax != 25000 || s.Requests != 12 || s.AgeH != 36 {
		t.Fatalf("got %+v (views %v)", s, s.ViewsMax)
	}
}

func TestStoredRecut(t *testing.T) {
	for stored, want := range map[string]int{``: 0, `not json`: 0, `{"undo":2}`: 0, `{"undo":2,"duration_recut":3}`: 3} {
		if got := storedRecut([]byte(stored)); got != want {
			t.Errorf("storedRecut(%s) = %d, want %d", stored, got, want)
		}
	}
}

// expectSignals: testVideo's signal queries counted after `since` up to `asOf`, with down votes
// and undo events given as {total, new}, and the re-cuts' total.
func expectSignals(mock sqlmock.Sqlmock, since, asOf time.Time, down, undo [2]int, recut int) {
	mock.ExpectQuery("FROM votes").WithArgs(7, testBounds(since), asOf).
		WillReturnRows(sqlmock.NewRows([]string{"up", "down", "new_down"}).AddRow(0, down[0], down[1]))
	mock.ExpectQuery("prv_events_interval_undo").WithArgs("-1_456000001", testBounds(since), asOf).
		WillReturnRows(sqlmock.NewRows([]string{"count", "new"}).AddRow(undo[0], undo[1]))
	mock.ExpectQuery("prv_events_interval_click").WithArgs("-1_456000001", testBounds(since), asOf).
		WillReturnRows(sqlmock.NewRows([]string{"count", "new"}).AddRow(0, 0))
	mock.ExpectQuery("FROM markups").WithArgs(7, published, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating", "created"}))
	mock.ExpectQuery("FROM videos").WithArgs("-1_456000001", 7, published, testVideo.LastSeenAt, testVideo.Duration, 2, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(recut, recut))
}
