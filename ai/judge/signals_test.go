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
		regexp.QuoteMeta(`vt."createdAt" DESC, vt.id DESC`)).
		WithArgs(7, testVideo.Data).
		WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(3, 1))
	up, down, err := votes(db, testVideo)
	if err != nil || up != 3 || down != 1 {
		t.Fatalf("got %d %d %v", up, down, err)
	}
}

func TestEventsMatchTheEntriesByNativeID(t *testing.T) {
	db, mock := newMock(t)
	for table, n := range map[string]int{"prv_events_interval_undo": 2, "prv_events_interval_click": 5} {
		mock.ExpectQuery(`(?s)`+regexp.QuoteMeta("SELECT COUNT(*) FROM "+table+" ev JOIN jsonb_to_recordset($2::jsonb)")+
			`.*`+regexp.QuoteMeta("WHERE ev.video_native_id = $1")).
			WithArgs("-1_456000001", testVideo.Data).
			WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(n))
		got, err := events(db, table, testVideo)
		if err != nil || got != n {
			t.Fatalf("%s: got %d %v", table, got, err)
		}
	}
}

func TestHumanMarkupsSincePublish(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)FROM markups m.*LEFT JOIN users u ON u.id = m.internal_user_id.*`+
		regexp.QuoteMeta(`m.deleted_at IS NULL AND m."createdAt" >= $2`)).
		WithArgs(7, published).
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}).
			AddRow(2, 32.0, 68.0, 0).    // agrees with the AI entry
			AddRow(2, 100.0, 120.0, 5).  // a sponsor the AI does not have
			AddRow(2, 200.0, 230.0, -3). // the same, by an author rated down
			AddRow(1, 0.0, 15.0, 0))     // intro: the detector never marks it
	total, conflicting, err := humanMarkups(db, testVideo, testCategories)
	if err != nil || total != 4 || conflicting != 1 {
		t.Fatalf("got %d %d %v", total, conflicting, err)
	}
}

func TestDurationVariantsAndRecut(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery(`(?s)`+regexp.QuoteMeta(`COUNT(*) FILTER (WHERE "createdAt" > $3 AND "createdAt" < $4)`)+`.*`+
		regexp.QuoteMeta(`native_id = $1 AND id <> $2 AND ABS(duration - $5::int) > $6`)).
		WithArgs("-1_456000001", 7, published, testVideo.LastSeenAt, testVideo.Duration, 2).
		WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(2, 1))
	variants, recut, err := durationVariants(db, testVideo)
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
	s, err := collectSignals(db, testVideo, testCategories, published.Add(36*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := Counters{VotesUp: 1, Undo: 1, Clicks: 4}
	if s.Counters != want || *s.ViewsMax != 25000 || s.Requests != 12 || s.AgeH != 36 {
		t.Fatalf("got %+v (views %v)", s, s.ViewsMax)
	}
}

func expectSignals(mock sqlmock.Sqlmock, undo int) {
	mock.ExpectQuery("FROM votes").WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(0, 0))
	mock.ExpectQuery("prv_events_interval_undo").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(undo))
	mock.ExpectQuery("prv_events_interval_click").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("FROM markups").WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectQuery("FROM videos").WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(0, 0))
}

func TestJudgeVideoSkipsAJudgedVideoWhoseCountersDidNotMove(t *testing.T) {
	db, mock := newMock(t)
	v := testVideo
	v.JudgedAt = sql.NullTime{Time: published.Add(25 * time.Hour), Valid: true}
	v.JudgeCounters = []byte(`{"undo":1}`)
	expectSignals(mock, 1)
	if err := judgeVideo(db, v, testCategories, published.Add(30*time.Hour)); err != nil {
		t.Fatal(err)
	}
}

func TestJudgeVideoRecordsAReviewWhileTheLLMIsMissing(t *testing.T) {
	db, mock := newMock(t)
	v := testVideo
	v.JudgedAt = sql.NullTime{Time: published.Add(25 * time.Hour), Valid: true}
	v.JudgeCounters = []byte(`{"undo":1}`)
	expectSignals(mock, 2)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT withdrawn_at FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"withdrawn_at"}).AddRow(nil))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO prv_ai_judgements (video_id, decision, "by", reason, signals) VALUES ($1, $2, 'rules', $3, $4)`)).
		WithArgs(7, "review", "needs_llm: undo=2", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET judged_at = NOW(), judge_counters = $2")).
		WithArgs("-1_456000001", []byte(`{"votes_up":0,"votes_down":0,"undo":2,"clicks":0,"human_markups":0,"conflicting_markups":0,"duration_variants":0,"duration_recut":0}`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := judgeVideo(db, v, testCategories, published.Add(30*time.Hour)); err != nil {
		t.Fatal(err)
	}
}

func TestJudgeVideoWithdrawsARecut(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectQuery("FROM votes").WillReturnRows(sqlmock.NewRows([]string{"up", "down"}).AddRow(0, 0))
	mock.ExpectQuery("prv_events_interval_undo").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("prv_events_interval_click").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("FROM markups").WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectQuery("FROM videos").WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(1, 1))
	mock.ExpectBegin()
	mock.ExpectQuery("FOR UPDATE").WillReturnRows(sqlmock.NewRows([]string{"withdrawn_at"}).AddRow(nil))
	mock.ExpectExec("INSERT INTO prv_ai_judgements").WithArgs(7, "withdraw", sqlmock.AnyArg(), sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(regexp.QuoteMeta("withdrawn_by = 'duration'")).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = 'withdrawn'")).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("judged_at = NOW()").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := judgeVideo(db, testVideo, testCategories, published.Add(30*time.Hour)); err != nil {
		t.Fatal(err)
	}
}
