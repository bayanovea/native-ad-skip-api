package pipeline

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

var testCfg = Config{MinViews: 10000, FallbackRequests: 3, DailyBudget: 200, BatchMax: 100}

func TestClaimQueuedTakesTheBudgetLeft(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(regexp.QuoteMeta("FROM prv_ai_runs WHERE created_at > NOW() - INTERVAL '24 hours'")).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(198))
	mock.ExpectBegin()
	// views from the extension, or unknown views and enough GETs (the fallback), or a retry that is due
	mock.ExpectQuery(regexp.QuoteMeta("native_id ~ '^-?[0-9]+_[0-9]+$' AND (")+`\s*`+regexp.QuoteMeta("(status = 'seen' AND (views_max >= $1 OR (views_max IS NULL AND requests >= $2)))")+
		`(?s).*status = 'queued' AND next_attempt_at <= NOW\(\).*ORDER BY first_seen_at.*LIMIT \$3 FOR UPDATE SKIP LOCKED`).
		WithArgs(10000, 3, 2).
		WillReturnRows(sqlmock.NewRows([]string{"native_id", "views_max", "attempts"}).
			AddRow("-1_456000001", 25000, 0).
			AddRow("-1_456000002", nil, 1))
	mock.ExpectExec(regexp.QuoteMeta("SET status = 'fetching'")).
		WithArgs(sqlmock.AnyArg()).
		WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()

	got, err := claimQueued(db, testCfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].nativeID != "-1_456000001" || got[0].viewsMax.Int64 != 25000 ||
		got[1].viewsMax.Valid || got[1].attempts != 1 {
		t.Fatalf("got %+v", got)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestClaimQueuedStopsAtTheBudget(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("FROM prv_ai_runs").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(200))
	got, err := claimQueued(db, testCfg)
	if err != nil || got != nil {
		t.Fatalf("budget spent: got %v, %v", got, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestClaimQueuedBatchMax(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("FROM prv_ai_runs").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectBegin()
	mock.ExpectQuery("FOR UPDATE SKIP LOCKED").WithArgs(10000, 3, 100).
		WillReturnRows(sqlmock.NewRows([]string{"native_id", "views_max", "attempts"}))
	mock.ExpectRollback()
	got, err := claimQueued(db, testCfg)
	if err != nil || got != nil {
		t.Fatalf("empty queue: got %v, %v", got, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestViewCount(t *testing.T) {
	for raw, want := range map[string]int64{
		`{"id":"x","view_count":12345}`: 12345,
		`{"id":"x","view_count":null}`:  0,
		`{"id":"x"}`:                    0,
		`not json`:                      0,
	} {
		if got, ok := viewCount([]byte(raw)); got != want || ok != (want > 0) {
			t.Errorf("viewCount(%s) = %d %v, want %d", raw, got, ok, want)
		}
	}
}

func TestNextAttempt(t *testing.T) {
	cases := []struct {
		attempts int
		noTrack  bool
		status   string
		wait     time.Duration
	}{
		{1, true, "queued", 6 * time.Hour},
		{2, true, "queued", 24 * time.Hour},
		{3, true, "queued", 72 * time.Hour},
		{4, true, "no_track", 0},
		{1, false, "queued", 6 * time.Hour},
		{2, false, "queued", 24 * time.Hour},
		{3, false, "failed", 0},
	}
	for _, c := range cases {
		status, wait := nextAttempt(c.attempts, c.noTrack)
		if status != c.status || wait != c.wait {
			t.Errorf("nextAttempt(%d, noTrack=%v) = %s %s, want %s %s", c.attempts, c.noTrack, status, wait, c.status, c.wait)
		}
	}
}

func TestMarkAttemptNoTrack(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, attempts = $3, next_attempt_at = $4")).
		WithArgs("-1_456000001", "queued", 2, sqlmock.AnyArg(), "no ru subtitle track").
		WillReturnResult(sqlmock.NewResult(0, 1))
	status, err := markAttempt(db, queued{nativeID: "-1_456000001", attempts: 1}, true, "no ru subtitle track")
	if err != nil || status != "queued" {
		t.Fatalf("got %s, %v", status, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestMarkAttemptAnErrorAfterTwoNoTrackTriesFailsTheVideo(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// attempts is one fetch budget: no track at 1 and 2, then a yt-dlp error is the third attempt
	mock.ExpectExec("UPDATE prv_ai_videos SET status").WithArgs("-1_456000001", "failed", 3, nil, "ytdlp: boom").
		WillReturnResult(sqlmock.NewResult(0, 1))
	if status, err := markAttempt(db, queued{nativeID: "-1_456000001", attempts: 2}, false, "ytdlp: boom"); err != nil || status != "failed" {
		t.Fatalf("got %s, %v", status, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestClaimOne(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	expect := func(status string, stale, hasRow bool) {
		mock.ExpectExec("INSERT INTO prv_ai_videos").WithArgs("-1_456000001").WillReturnResult(sqlmock.NewResult(0, 0))
		mock.ExpectQuery(regexp.QuoteMeta(staleFetching + ", EXISTS (SELECT 1 FROM prv_ai_video_calculateds WHERE native_id = $1)")).WithArgs("-1_456000001").
			WillReturnRows(sqlmock.NewRows([]string{"status", "stale", "exists"}).AddRow(status, stale, hasRow))
	}

	for _, id := range []string{"", "x", "-1_", "1_2/../3", "-1_456000001?x=1"} {
		if _, err := claimOne(db, id); err == nil || !strings.Contains(err.Error(), "is not a prv video id") {
			t.Errorf("%q: got %v", id, err)
		}
	}

	for _, c := range []struct {
		status string
		stale  bool
		hasRow bool
		err    string
	}{
		{"detecting", false, false, "already being fetched or detected"},
		{"fetching", false, false, "already being fetched or detected"},
		{"published", false, true, "already has an AI row (status published): a re-detect is not supported"},
		{"withdrawn", false, true, "already has an AI row (status withdrawn)"},
	} {
		expect(c.status, c.stale, c.hasRow)
		if _, err := claimOne(db, "-1_456000001"); err == nil || !strings.Contains(err.Error(), c.err) {
			t.Errorf("%s: got %v, want %q", c.status, err, c.err)
		}
	}

	expect("failed", false, false)
	mock.ExpectQuery(`SET status = 'fetching'(?s).*AND status = \$2`).
		WithArgs("-1_456000001", "failed").WillReturnRows(sqlmock.NewRows([]string{"views_max", "attempts"}).AddRow(nil, 3))
	q, err := claimOne(db, "-1_456000001")
	if err != nil || q.attempts != 3 || q.viewsMax.Valid {
		t.Fatalf("a failed video is claimed again: got %+v %v", q, err)
	}

	// An interrupted manual run with the cron switched off: nothing else would ever reclaim the row.
	expect("fetching", true, false)
	mock.ExpectQuery(`SET status = 'fetching'(?s).*AND status = \$2 AND \(status <> 'fetching' OR `+regexp.QuoteMeta(staleFetching)+`\)`).
		WithArgs("-1_456000001", "fetching").WillReturnRows(sqlmock.NewRows([]string{"views_max", "attempts"}).AddRow(nil, 1))
	if q, err = claimOne(db, "-1_456000001"); err != nil || q.attempts != 1 {
		t.Fatalf("a fetching row untouched for an hour is claimed: got %+v %v", q, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
