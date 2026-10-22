package judge

import (
	"database/sql"
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

func TestVotesCountsEachUsersLatestVoteOnTheEntries(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)COUNT\(DISTINCT user_id\) FILTER \(WHERE vote > 0\).*`+
		regexp.QuoteMeta(`DISTINCT ON (vt.user_id, vt.category_id, vt.start, vt."end")`)+`.*`+
		regexp.QuoteMeta(`jsonb_to_recordset($2::jsonb)`)+`.*`+
		regexp.QuoteMeta(`WHERE vt.video_id = $1 AND vt."createdAt" <= $3`)+`.*`+
		regexp.QuoteMeta(`vt."createdAt" DESC, vt.id DESC`)).
		WithArgs(7, testVideo.Data, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(3, 1))
	up, down, err := votes(db, testVideo, asOf)
	if err != nil || up != 3 || down != 1 {
		t.Fatalf("got %d %d %v", up, down, err)
	}
}

func TestEventsMatchTheEntriesByNativeID(t *testing.T) {
	db, mock := newMock(t)
	for table, n := range map[string]int{"prv_events_interval_undo": 2, "prv_events_interval_click": 5} {
		mock.ExpectQuery(`(?s)`+regexp.QuoteMeta("SELECT COUNT(*) FROM "+table+" ev JOIN jsonb_to_recordset($2::jsonb)")+
			`.*`+regexp.QuoteMeta(`WHERE ev.video_native_id = $1 AND ev."createdAt" <= $3`)).
			WithArgs("-1_456000001", testVideo.Data, asOf).
			WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(n))
		got, err := events(db, table, testVideo, asOf)
		if err != nil || got != n {
			t.Fatalf("%s: got %d %v", table, got, err)
		}
	}
}

func TestHumanMarkupsSincePublish(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)FROM markups m.*LEFT JOIN users u ON u.id = m.internal_user_id.*`+
		regexp.QuoteMeta(`m.deleted_at IS NULL AND m."createdAt" >= $2 AND m."createdAt" <= $3`)).
		WithArgs(7, published, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}).
			AddRow(2, 32.0, 68.0, 0).    // agrees with the AI entry
			AddRow(2, 100.0, 120.0, 5).  // a sponsor the AI does not have
			AddRow(2, 200.0, 230.0, -3). // the same, by an author rated down
			AddRow(1, 0.0, 15.0, 0))     // intro: the detector never marks it
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
	mock.ExpectQuery("FROM votes").WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(1, 0))
	mock.ExpectQuery("prv_events_interval_undo").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	mock.ExpectQuery("prv_events_interval_click").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(4))
	mock.ExpectQuery("FROM markups").WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectQuery("FROM videos").WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(0, 0))
	s, err := collectSignals(db, testVideo, testCategories, asOf)
	if err != nil {
		t.Fatal(err)
	}
	want := Counters{VotesUp: 1, Undo: 1, Clicks: 4}
	if s.Counters != want || *s.ViewsMax != 25000 || s.Requests != 12 || s.AgeH != 36 {
		t.Fatalf("got %+v (views %v)", s, s.ViewsMax)
	}
}

func expectSignals(mock sqlmock.Sqlmock, undo, recut int) {
	mock.ExpectQuery("FROM votes").WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(0, 0))
	mock.ExpectQuery("prv_events_interval_undo").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(undo))
	mock.ExpectQuery("prv_events_interval_click").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("FROM markups").WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectQuery("FROM videos").WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(recut, recut))
}

// expectSignalsAsOf is expectSignals for testVideo counted up to asOf.
func expectSignalsAsOf(mock sqlmock.Sqlmock, asOf time.Time, undo, recut int) {
	mock.ExpectQuery("FROM votes").WithArgs(7, testVideo.Data, asOf).WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(0, 0))
	mock.ExpectQuery("prv_events_interval_undo").WithArgs("-1_456000001", testVideo.Data, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(undo))
	mock.ExpectQuery("prv_events_interval_click").WithArgs("-1_456000001", testVideo.Data, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("FROM markups").WithArgs(7, published, asOf).WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectQuery("FROM videos").WithArgs("-1_456000001", 7, published, testVideo.LastSeenAt, testVideo.Duration, 2, asOf).
		WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(recut, recut))
}
