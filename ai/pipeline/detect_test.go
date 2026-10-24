package pipeline

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

func TestConfigFromEnvDefaultsOff(t *testing.T) {
	for _, k := range []string{"AI_DETECT_ENABLED", "AI_MIN_VIEWS", "AI_FALLBACK_REQUESTS", "AI_DAILY_BUDGET_VIDEOS", "AI_BATCH_MAX", "AI_FETCH_PAUSE", "AI_MODEL", "AI_CLIENT", "YTDLP_BIN"} {
		t.Setenv(k, "")
	}
	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	want := Config{MinViews: 10000, FallbackRequests: 5, DailyBudget: 200, BatchMax: 5, FetchPause: 40 * time.Second, Model: "claude-sonnet-5-5", Client: "anthropic",
		YtdlpBin: "/usr/local/bin/yt-dlp"}
	if c.DetectEnabled || c.MinViews != want.MinViews || c.FallbackRequests != want.FallbackRequests ||
		c.DailyBudget != want.DailyBudget || c.BatchMax != want.BatchMax || c.FetchPause != want.FetchPause || c.Model != want.Model || c.Client != want.Client ||
		c.YtdlpBin != want.YtdlpBin {
		t.Fatalf("got %+v", c)
	}

	t.Setenv("AI_DETECT_ENABLED", "on")
	t.Setenv("AI_MIN_VIEWS", "500")
	if c, err = ConfigFromEnv(); err != nil || !c.DetectEnabled || c.MinViews != 500 {
		t.Fatalf("got %+v, %v", c, err)
	}
	t.Setenv("AI_FETCH_PAUSE", "0")
	if c, err = ConfigFromEnv(); err != nil || c.FetchPause != 0 {
		t.Fatalf("got %+v, %v", c, err)
	}
	t.Setenv("AI_FETCH_PAUSE", "-1s")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("negative pause: want an error")
	}
	t.Setenv("AI_FETCH_PAUSE", "")
	t.Setenv("AI_BATCH_MAX", "ten")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("bad integer: want an error")
	}
}

func TestJitter(t *testing.T) {
	if jitter(0) != 0 {
		t.Fatal("no pause: want 0")
	}
	for range 1000 {
		if d := jitter(40 * time.Second); d < 20*time.Second || d >= 60*time.Second {
			t.Fatalf("jitter(40s) = %v, want [20s, 60s)", d)
		}
	}
}

// fakeBatch is a batch transport whose batches end and fail on demand.
type fakeBatch struct {
	ended               bool
	submitErr, pollErr  error
	submitted, detected []string
}

func (f *fakeBatch) Model() string { return "claude-sonnet-5-5" }
func (f *fakeBatch) Detect(_ context.Context, req detector.Request) (detector.Result, error) {
	f.detected = append(f.detected, req.Key)
	return detector.Result{}, errors.New("expired")
}
func (f *fakeBatch) Submit(_ context.Context, reqs []detector.Request) (string, error) {
	for _, r := range reqs {
		f.submitted = append(f.submitted, r.Key)
	}
	return "msgbatch_1", f.submitErr
}
func (f *fakeBatch) Poll(context.Context, string) (bool, error) { return f.ended, f.pollErr }

func batchRun(t *testing.T) (*detectRun, sqlmock.Sqlmock, *fakeBatch) {
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
	f := &fakeBatch{}
	return &detectRun{db: db, client: f, batch: f}, mock, f
}

func expectWaiting(mock sqlmock.Sqlmock) {
	mock.ExpectQuery("WHERE v.status = 'detecting' AND v.batch_id IS NOT NULL").WillReturnRows(
		sqlmock.NewRows([]string{"native_id", "batch_id", "id", "video_id", "transcript"}).
			AddRow("-1_456000001", "msgbatch_1", 11, 7, []byte(`{"meta":{},"cues":[]}`)).
			AddRow("-1_456000002", "msgbatch_1", 12, 8, []byte(`{"meta":{},"cues":[]}`)))
}

func TestPollLeavesARunningBatchForALaterTick(t *testing.T) {
	r, mock, f := batchRun(t)
	expectWaiting(mock)
	if failed, err := r.poll(context.Background()); failed != 0 || err != nil || len(f.detected) != 0 {
		t.Fatalf("got %d %v, detected %v", failed, err, f.detected)
	}
}

func TestPollErrorCountsTheBatchsVideos(t *testing.T) {
	r, mock, f := batchRun(t)
	f.pollErr = errors.New("529 overloaded")
	expectWaiting(mock)
	if failed, err := r.poll(context.Background()); failed != 2 || err != nil {
		t.Fatalf("got %d %v", failed, err)
	}
}

func TestPollListErrorIsTheTicks(t *testing.T) {
	r, mock, _ := batchRun(t)
	mock.ExpectQuery("v.status = 'detecting'").WillReturnError(errors.New("connection refused"))
	if _, err := r.poll(context.Background()); err == nil {
		t.Fatal("want the list error")
	}
}

func TestPollResolvesAnEndedBatchAFailedResultIsTheVideosOutcome(t *testing.T) {
	r, mock, f := batchRun(t)
	f.ended = true
	expectWaiting(mock)
	for _, id := range []string{"-1_456000001", "-1_456000002"} {
		mock.ExpectBegin()
		mock.ExpectQuery(regexp.QuoteMeta("SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE")).WithArgs(id).
			WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("detecting"))
		mock.ExpectExec("UPDATE prv_ai_runs SET raw_output").WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, last_error = $3")).WithArgs(id, "failed", "expired").
			WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectCommit()
	}
	if failed, err := r.poll(context.Background()); failed != 0 || err != nil || len(f.detected) != 2 {
		t.Fatalf("got %d %v, detected %v", failed, err, f.detected)
	}
}

func TestTickReturnsItsFailedSteps(t *testing.T) {
	r, mock, _ := batchRun(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM prv_ai_runs")).WillReturnError(errors.New("budget down"))
	mock.ExpectQuery("v.status = 'detecting'").WillReturnError(errors.New("list down"))
	mock.ExpectQuery(regexp.QuoteMeta("SET status = 'failed'")).WillReturnRows(sqlmock.NewRows([]string{"native_id"}))
	failed, err := r.tick(context.Background())
	if failed != 0 || err == nil || !strings.Contains(err.Error(), "claim: daily budget: budget down") || !strings.Contains(err.Error(), "list batches: list down") {
		t.Fatalf("got %d %v", failed, err)
	}
}

func TestExpireFailsRunsOlderThanADay(t *testing.T) {
	r, mock, _ := batchRun(t)
	mock.ExpectQuery(regexp.QuoteMeta("SET status = 'failed', last_error = 'no model result after 24 h'") + `(?s).*` +
		regexp.QuoteMeta("WHERE status = 'detecting' AND updated_at < NOW() - INTERVAL '24 hours'")).
		WillReturnRows(sqlmock.NewRows([]string{"native_id"}).AddRow("-1_456000001"))
	if err := r.expire(); err != nil {
		t.Fatal(err)
	}
}

func readyVideo(id string) pending {
	return pending{q: queued{nativeID: id, attempts: 1}, videoID: 7, meta: transcript.Meta{NativeID: id}, req: detector.Request{Key: id}}
}

func expectStartRun(mock sqlmock.Sqlmock, id string, runID int64) {
	mock.ExpectBegin()
	mock.ExpectQuery("INSERT INTO prv_ai_runs").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(runID))
	mock.ExpectExec(regexp.QuoteMeta("SET status = 'detecting', batch_id = NULL")).WithArgs(id).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
}

func TestSubmitWritesTheRunRowsBeforeTheBatch(t *testing.T) {
	r, mock, f := batchRun(t)
	expectStartRun(mock, "-1_456000001", 11)
	expectStartRun(mock, "-1_456000002", 12)
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET batch_id = $2")).WithArgs(sqlmock.AnyArg(), "msgbatch_1").
		WillReturnResult(sqlmock.NewResult(0, 2))
	if failed := r.submit(context.Background(), []pending{readyVideo("-1_456000001"), readyVideo("-1_456000002")}); failed != 0 {
		t.Fatalf("failed %d", failed)
	}
	if len(f.submitted) != 2 {
		t.Fatalf("submitted %v", f.submitted)
	}
}

func TestSubmitErrorDropsTheRunsAndCountsAnAttempt(t *testing.T) {
	r, mock, f := batchRun(t)
	f.submitErr = errors.New("400 invalid request")
	expectStartRun(mock, "-1_456000001", 11)
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM prv_ai_runs WHERE id = $1")).WithArgs(11).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, attempts = $3")).
		WithArgs("-1_456000001", "queued", 2, sqlmock.AnyArg(), "batch submit: 400 invalid request").WillReturnResult(sqlmock.NewResult(0, 1))
	if failed := r.submit(context.Background(), []pending{readyVideo("-1_456000001")}); failed != 1 {
		t.Fatalf("failed %d", failed)
	}
}

// stubYtdlp is a yt-dlp whose -j prints a video with a ru track and whose subtitle
// download writes vtt to <-o>.ru.vtt, or nothing when vtt is "".
func stubYtdlp(t *testing.T, vtt string) *ytdlp.Runner {
	t.Helper()
	dir := t.TempDir()
	info := `{"id":"-1_456000001","duration":600,"subtitles":{"ru":[{"ext":"Ru AUTO","url":"https://example.invalid/a.vtt"}]}}`
	script := "#!/bin/sh\nout=\nsubs=\nwhile [ $# -gt 0 ]; do case \"$1\" in -o) out=$2; shift ;; --write-subs) subs=1 ;; esac; shift; done\n" +
		"if [ -z \"$subs\" ]; then cat " + filepath.Join(dir, "info.json") + "; exit 0; fi\n" +
		"if [ -f " + filepath.Join(dir, "subs.vtt") + " ]; then cp " + filepath.Join(dir, "subs.vtt") + " \"$out.ru.vtt\"; fi\n"
	files := map[string]string{"yt-dlp": script, "info.json": info}
	if vtt != "" {
		files["subs.vtt"] = vtt
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return &ytdlp.Runner{Bin: filepath.Join(dir, "yt-dlp"), Attempts: 1, Timeout: 10 * time.Second}
}

func TestFetchTrackWithoutCues(t *testing.T) {
	for _, c := range []struct {
		name, vtt, status, lastErr string
	}{
		// yt-dlp listed the track, then wrote no file: a failed fetch, not a missing track
		{"no file", "", "queued", "yt-dlp reported a track but wrote no .vtt"},
		{"no cues", "WEBVTT\n\n", "queued", "no ru subtitle track"},
	} {
		t.Run(c.name, func(t *testing.T) {
			r, mock, _ := batchRun(t)
			r.ytdlp = stubYtdlp(t, c.vtt)
			r.prv, _ = provider.Lookup("prv")
			mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, attempts = $3")).
				WithArgs("-1_456000001", c.status, 1, sqlmock.AnyArg(), c.lastErr).WillReturnResult(sqlmock.NewResult(0, 1))
			q := queued{nativeID: "-1_456000001", viewsMax: sql.NullInt64{Int64: 20000, Valid: true}}
			if failed := r.detect(context.Background(), []queued{q}, true); failed != 0 {
				t.Fatalf("failed = %d, want 0: one failed fetch is the video's", failed)
			}
		})
	}
}

func TestFetchWithoutViewCountPassesOnRequests(t *testing.T) {
	r, mock, _ := batchRun(t)
	r.ytdlp = stubYtdlp(t, "WEBVTT\n\n") // no cues: stops right after the views gate
	r.prv, _ = provider.Lookup("prv")
	// Only the no-track attempt: no views_max write, no `seen`.
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, attempts = $3")).
		WithArgs("-1_456000001", "queued", 1, sqlmock.AnyArg(), "no ru subtitle track").WillReturnResult(sqlmock.NewResult(0, 1))
	p, err := r.fetch(context.Background(), queued{nativeID: "-1_456000001"}, true)
	if p != nil || err != nil {
		t.Fatalf("got %+v %v", p, err)
	}
}

func TestDetectEveryFetchFailedIsTheHosts(t *testing.T) {
	r, _, _ := batchRun(t)
	r.ytdlp = stubYtdlp(t, "")
	r.prv, _ = provider.Lookup("prv")
	claimed := []queued{
		{nativeID: "-1_456000001", viewsMax: sql.NullInt64{Int64: 20000, Valid: true}},
		{nativeID: "-1_456000002", viewsMax: sql.NullInt64{Int64: 20000, Valid: true}},
	}
	// No UPDATE expected: no attempt spent, the rows stay `fetching`.
	if failed := r.detect(context.Background(), claimed, true); failed != 2 {
		t.Fatalf("failed = %d, want 2", failed)
	}
}
