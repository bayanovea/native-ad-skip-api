package pipeline

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/openai/openai-go/v3"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

// testPrv is prv with the e2e templates (docker-compose.e2e.yml); Register panics on a duplicate, so once per binary.
var testPrv = func() provider.Provider {
	provider.Register(provider.Def{Name: "prv", VideoURL: "https://example.invalid/video{id}", LinkAt: "https://example.invalid/video{id}?t={t}"})
	p, _ := provider.Lookup("prv")
	return p
}()

func TestConfigFromEnvDefaultsOff(t *testing.T) {
	for _, k := range []string{"AI_DETECT_ENABLED", "AI_MIN_VIEWS", "AI_MIN_REQUESTS", "AI_DAILY_BUDGET_VIDEOS", "AI_BATCH_MAX", "AI_MIN_SEGMENT_SECONDS", "AI_FETCH_PAUSE", "AI_MODEL", "AI_CLIENT", "AI_DETECT_CLIENT", "YTDLP_BIN", "AI_SECOND_ENABLED", "AI_SECOND_CLIENT", "AI_SECOND_MODEL", "AI_CHAPTERS_ENABLED", "AI_CHAPTER_EDGE_SECONDS"} {
		t.Setenv(k, "")
	}
	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.SecondEnabled || c.SecondClient != "openai" || c.SecondModel != "gpt-6-luna" {
		t.Fatalf("second opinion: got %v %q %q, want off, openai, gpt-6-luna", c.SecondEnabled, c.SecondClient, c.SecondModel)
	}
	if c.ChaptersEnabled || c.ChapterEdge != 10 {
		t.Fatalf("chapters: got %v %d, want off, 10", c.ChaptersEnabled, c.ChapterEdge)
	}
	want := Config{MinViews: 500000, MinRequests: 20, DailyBudget: 300, BatchMax: 5, MinSegmentSeconds: 5, FetchPause: 40 * time.Second, Model: "claude-sonnet-5-5", Client: "anthropic",
		YtdlpBin: "/usr/local/bin/yt-dlp"}
	if c.DetectEnabled || c.MinViews != want.MinViews || c.MinRequests != want.MinRequests ||
		c.DailyBudget != want.DailyBudget || c.BatchMax != want.BatchMax || c.MinSegmentSeconds != want.MinSegmentSeconds || c.FetchPause != want.FetchPause || c.Model != want.Model || c.Client != want.Client ||
		c.YtdlpBin != want.YtdlpBin {
		t.Fatalf("got %+v", c)
	}

	t.Setenv("AI_DETECT_ENABLED", "on")
	t.Setenv("AI_MIN_VIEWS", "500")
	t.Setenv("AI_FALLBACK_REQUESTS", "5") // the pre-2026-10-28 name: ignored
	if c, err = ConfigFromEnv(); err != nil || !c.DetectEnabled || c.MinViews != 500 || c.MinRequests != 20 {
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
	t.Setenv("AI_MIN_SEGMENT_SECONDS", "3")
	if c, err = ConfigFromEnv(); err != nil || c.MinSegmentSeconds != 3 {
		t.Fatalf("got %+v, %v", c, err)
	}
	for _, bad := range []string{"0", "-1", "2.5"} {
		t.Setenv("AI_MIN_SEGMENT_SECONDS", bad)
		if _, err := ConfigFromEnv(); err == nil {
			t.Fatalf("AI_MIN_SEGMENT_SECONDS=%s: want an error", bad)
		}
	}
	t.Setenv("AI_MIN_SEGMENT_SECONDS", "")
	t.Setenv("AI_BATCH_MAX", "ten")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("bad integer: want an error")
	}
}

func TestConfigSecondClient(t *testing.T) {
	t.Setenv("AI_SECOND_ENABLED", "on")
	if c, err := ConfigFromEnv(); err != nil || !c.SecondEnabled {
		t.Fatalf("on: got %+v, %v", c, err)
	}
	for _, v := range []string{"openai", "anthropic", "fixture"} {
		t.Setenv("AI_SECOND_CLIENT", v)
		if c, err := ConfigFromEnv(); err != nil || c.SecondClient != v {
			t.Fatalf("%s: got %+v, %v", v, c, err)
		}
	}
	for _, bad := range []string{"off", "gemini"} {
		t.Setenv("AI_SECOND_CLIENT", bad)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AI_SECOND_CLIENT") {
			t.Fatalf("%s: want an error naming AI_SECOND_CLIENT, got %v", bad, err)
		}
	}
}

func TestConfigDetectClientFallsBackToAIClient(t *testing.T) {
	for _, c := range []struct{ detect, shared, want string }{
		{"", "", "anthropic"},
		{"", "fixture", "fixture"},
		{"openai-batch", "fixture", "openai-batch"},
	} {
		t.Setenv("AI_DETECT_CLIENT", c.detect)
		t.Setenv("AI_CLIENT", c.shared)
		if got, err := ConfigFromEnv(); err != nil || got.Client != c.want {
			t.Fatalf("AI_DETECT_CLIENT=%q AI_CLIENT=%q: got %q %v, want %q", c.detect, c.shared, got.Client, err, c.want)
		}
	}
}

func TestConfigChapters(t *testing.T) {
	t.Setenv("AI_CHAPTERS_ENABLED", "on")
	t.Setenv("AI_CHAPTER_EDGE_SECONDS", "15")
	if c, err := ConfigFromEnv(); err != nil || !c.ChaptersEnabled || c.ChapterEdge != 15 {
		t.Fatalf("got %+v, %v", c, err)
	}
	for _, bad := range []string{"0", "abc", "-1"} {
		t.Setenv("AI_CHAPTER_EDGE_SECONDS", bad)
		if _, err := ConfigFromEnv(); err == nil || !strings.Contains(err.Error(), "AI_CHAPTER_EDGE_SECONDS") {
			t.Fatalf("%s: want an error naming AI_CHAPTER_EDGE_SECONDS, got %v", bad, err)
		}
	}
}

func TestNewDetectRunSecondClientNeedsItsKey(t *testing.T) {
	prompt := filepath.Join(t.TempDir(), "v1.md")
	if err := os.WriteFile(prompt, []byte("p"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PROVIDER_VIDEO_URL", "https://example.invalid/video{id}")
	t.Setenv("PROVIDER_LINK_AT", "https://example.invalid/video{id}?t={t}")
	t.Setenv("OPENAI_API_KEY", "")
	cfg := Config{Client: "fixture", PromptPath: prompt, SecondEnabled: true, SecondClient: "openai", SecondModel: "gpt-6-luna"}
	if _, err := newDetectRun(cfg, true); err == nil || !strings.Contains(err.Error(), "OPENAI_API_KEY") {
		t.Fatalf("want a startup error naming OPENAI_API_KEY, got %v", err)
	}
	cfg.SecondClient = "fixture"
	r, err := newDetectRun(cfg, true)
	if err != nil || r.second == nil || r.second.Model() != "gpt-6-luna" || r.secondPrice.Input != 0.10 {
		t.Fatalf("fixture second client: %+v %v", r, err)
	}
	cfg.SecondEnabled, cfg.SecondClient = false, "openai"
	if r, err = newDetectRun(cfg, true); err != nil || r.second != nil {
		t.Fatalf("off: no client and no key needed, got %+v %v", r, err)
	}
}

func detectRunEnv(t *testing.T) string {
	t.Helper()
	prompt := filepath.Join(t.TempDir(), "v1.md")
	if err := os.WriteFile(prompt, []byte("p"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PROVIDER_VIDEO_URL", "https://example.invalid/video{id}")
	t.Setenv("PROVIDER_LINK_AT", "https://example.invalid/video{id}?t={t}")
	t.Setenv("ANTHROPIC_API_KEY", "test")
	t.Setenv("OPENAI_API_KEY", "test")
	return prompt
}

func TestNewDetectRunPicksTheTransport(t *testing.T) {
	prompt := detectRunEnv(t)
	for _, c := range []struct {
		client, model string
		manual        bool
		want          string // the client's type; batch or not follows from it
	}{
		{"anthropic", "claude-sonnet-5-5", false, "*detector.AnthropicBatch"},
		{"anthropic", "claude-sonnet-5-5", true, "*detector.Anthropic"},
		{"messages", "claude-sonnet-5-5", false, "*detector.Anthropic"},
		{"openai-batch", "gpt-6.1-terra", false, "*detector.OpenAIBatch"},
		{"openai-batch", "gpt-6.1-terra", true, "*detector.OpenAI"},
		{"openai", "gpt-6.1-terra", false, "*detector.OpenAI"},
		{"fixture", "gpt-6.1-terra", false, "*detector.FixtureClient"},
		{"fixture", "claude-sonnet-5-5", true, "*detector.FixtureClient"},
	} {
		r, err := newDetectRun(Config{Client: c.client, Model: c.model, PromptPath: prompt}, c.manual)
		if err != nil {
			t.Fatalf("%s manual=%v: %v", c.client, c.manual, err)
		}
		batch := strings.HasSuffix(c.want, "Batch") || (c.client == "fixture" && !c.manual)
		if got := fmt.Sprintf("%T", r.client); got != c.want || (r.batch != nil) != batch || (r.priceFactor == 0.5) != batch {
			t.Fatalf("%s manual=%v: client %s, batch %v, factor %v; want %s, batch %v", c.client, c.manual, got, r.batch != nil, r.priceFactor, c.want, batch)
		}
	}
	if _, err := newDetectRun(Config{Client: "gemini", Model: "gemini-3", PromptPath: prompt}, false); err == nil ||
		!strings.Contains(err.Error(), "AI_DETECT_CLIENT") || !strings.Contains(err.Error(), "openai-batch") {
		t.Fatalf("unknown client: want an error naming AI_DETECT_CLIENT and its values, got %v", err)
	}
}

func TestNewDetectRunChecksModelAgainstTransport(t *testing.T) {
	prompt := detectRunEnv(t)
	for _, c := range []struct {
		cfg  Config
		vars []string // nil: no error
	}{
		{Config{Client: "openai-batch", Model: "claude-sonnet-5-5"}, []string{"AI_MODEL", "AI_DETECT_CLIENT"}},
		{Config{Client: "anthropic", Model: "gpt-6.1-terra"}, []string{"AI_MODEL", "AI_DETECT_CLIENT"}},
		{Config{Client: "messages", Model: "gpt-6.1-terra"}, []string{"AI_MODEL", "AI_DETECT_CLIENT"}},
		{Config{Client: "anthropic", Model: "claude-sonnet-5-5", SecondEnabled: true, SecondClient: "anthropic", SecondModel: "gpt-6-luna"},
			[]string{"AI_SECOND_MODEL", "AI_SECOND_CLIENT"}},
		{Config{Client: "anthropic", Model: "claude-sonnet-5-5", SecondEnabled: true, SecondClient: "openai", SecondModel: "claude-haiku-5-5"},
			[]string{"AI_SECOND_MODEL", "AI_SECOND_CLIENT"}},
		{Config{Client: "anthropic", Model: "claude-sonnet-5-5", SecondClient: "anthropic", SecondModel: "gpt-6-luna"}, nil},
		{Config{Client: "fixture", Model: "claude-sonnet-5-5", SecondEnabled: true, SecondClient: "fixture", SecondModel: "claude-haiku-5-5"}, nil},
		{Config{Client: "openai-batch", Model: "gpt-6.1-terra", SecondEnabled: true, SecondClient: "anthropic", SecondModel: "claude-haiku-5-5"}, nil},
	} {
		c.cfg.PromptPath = prompt
		r, err := newDetectRun(c.cfg, false)
		if c.vars == nil {
			if err != nil {
				t.Fatalf("%+v: %v", c.cfg, err)
			}
			if c.cfg.SecondEnabled && c.cfg.SecondClient == "anthropic" && fmt.Sprintf("%T", r.second) != "*detector.Anthropic" {
				t.Fatalf("second client %T, want *detector.Anthropic", r.second)
			}
			continue
		}
		for _, v := range c.vars {
			if err == nil || !strings.Contains(err.Error(), v) {
				t.Fatalf("%+v: want an error naming %v, got %v", c.cfg, c.vars, err)
			}
		}
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
	return &detectRun{db: db, client: f, batch: f, batches: map[string]batchClient{vendorAnthropic: f}}, mock, f
}

func expectWaiting(mock sqlmock.Sqlmock) {
	mock.ExpectQuery("WHERE v.status = 'detecting' AND v.batch_id IS NOT NULL").WillReturnRows(
		sqlmock.NewRows([]string{"native_id", "batch_id", "id", "video_id", "model", "transcript", "chapters"}).
			AddRow("-1_456000001", "msgbatch_1", 11, 7, "claude-sonnet-5-5", []byte(`{"meta":{},"cues":[]}`), nil).
			AddRow("-1_456000002", "msgbatch_1", 12, 8, "claude-sonnet-5-5", []byte(`{"meta":{},"cues":[]}`), nil))
}

// expectPublishBegin is finish's start: the transaction, then publishLock before any row lock.
func expectPublishBegin(mock sqlmock.Sqlmock) {
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`SELECT pg_advisory_xact_lock(hashtext('ai detect publish'))`)).
		WillReturnResult(sqlmock.NewResult(0, 0))
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
		expectPublishBegin(mock)
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

// vendorBatch answers every request with an empty, valid result and records who polled.
type vendorBatch struct {
	fakeBatch
	model string
	err   error
}

func (v *vendorBatch) Model() string { return v.model }
func (v *vendorBatch) Detect(_ context.Context, req detector.Request) (detector.Result, error) {
	v.detected = append(v.detected, req.Key)
	return detector.Result{Usage: detector.Usage{InputTokens: 1_000_000}}, v.err
}

func expectWaitingModel(mock sqlmock.Sqlmock, model string) {
	mock.ExpectQuery("WHERE v.status = 'detecting' AND v.batch_id IS NOT NULL").WillReturnRows(
		sqlmock.NewRows([]string{"native_id", "batch_id", "id", "video_id", "model", "transcript", "chapters"}).
			AddRow("-1_456000001", "batch_1", 11, 7, model, []byte(`{"meta":{},"cues":[]}`), nil))
}

// An empty answer publishes nothing: the run's cost and the published mark are what the test reads.
func expectPublishedEmpty(mock sqlmock.Sqlmock, cost float64) {
	expectPublishBegin(mock)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE")).
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("detecting"))
	mock.ExpectExec("UPDATE prv_ai_runs SET raw_output").WithArgs(int64(11), nil, sqlmock.AnyArg(), cost).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`(?s)DISTINCT ON .*FROM votes`).WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectExec("INSERT INTO prv_ai_video_calculateds").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("UPDATE prv_ai_videos SET status = 'published'").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
}

// A batch is read through the vendor of its run's model, built on first use, priced at that model's batch price.
func TestPollRoutesABatchByItsRunsModel(t *testing.T) {
	for _, c := range []struct{ current, waiting, vendor string }{
		{"gpt-6.1-terra", "claude-sonnet-5-5", vendorAnthropic},
		{"claude-sonnet-5-5", "gpt-6.1-terra", vendorOpenAI},
	} {
		t.Run(c.waiting, func(t *testing.T) {
			r, mock, _ := batchRun(t)
			current := &vendorBatch{model: c.current}
			other := &vendorBatch{fakeBatch: fakeBatch{ended: true}, model: c.waiting}
			r.batch, r.client, r.priceFactor = current, current, 0.5
			r.batches = map[string]batchClient{vendorOf(c.current): current}
			var opened []string
			r.openBatch = func(vendor, model string) (batchClient, error) {
				opened = append(opened, vendor+" "+model)
				return other, nil
			}
			expectWaitingModel(mock, c.waiting)
			expectPublishedEmpty(mock, detector.Prices[c.waiting].Input*0.5)
			if failed, err := r.poll(context.Background()); failed != 0 || err != nil {
				t.Fatalf("got %d %v", failed, err)
			}
			if len(current.detected) != 0 || len(other.detected) != 1 || len(opened) != 1 || opened[0] != c.vendor+" "+c.waiting {
				t.Fatalf("current read %v, other read %v, opened %v", current.detected, other.detected, opened)
			}
		})
	}
}

func TestPollOtherVendorWithoutItsKeyFailsOnlyItsBatch(t *testing.T) {
	r, mock, _ := batchRun(t)
	r.openBatch = func(string, string) (batchClient, error) { return nil, errors.New("OPENAI_API_KEY is not set") }
	expectWaitingModel(mock, "gpt-6.1-terra")
	if failed, err := r.poll(context.Background()); failed != 1 || err != nil {
		t.Fatalf("got %d %v, want the batch's one video failed and no tick error", failed, err)
	}
}

func TestPollBatchFailedAsAWholeSpendsNoAttempt(t *testing.T) {
	r, mock, _ := batchRun(t)
	b := &vendorBatch{fakeBatch: fakeBatch{ended: true}, model: "gpt-6.1-terra",
		err: fmt.Errorf("%w: no result for %q (batch batch_1 failed; token_limit_exceeded: enqueued)", detector.ErrBatchFailed, "-1_456000001")}
	r.batches[vendorOpenAI] = b
	expectWaitingModel(mock, "gpt-6.1-terra")
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM prv_ai_runs WHERE id = $1")).WithArgs(int64(11)).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, next_attempt_at = $3, last_error = $4, batch_id = NULL")).
		WithArgs("-1_456000001", "queued", sqlmock.AnyArg(), sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	if failed, err := r.poll(context.Background()); failed != 1 || err != nil {
		t.Fatalf("got %d %v", failed, err)
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

func TestSubmitErrorDropsTheRunsAndSpendsNoAttempt(t *testing.T) {
	r, mock, f := batchRun(t)
	f.submitErr = errors.New("400 usage limits")
	expectStartRun(mock, "-1_456000001", 11)
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM prv_ai_runs WHERE id = $1")).WithArgs(11).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, next_attempt_at = $3, last_error = $4, batch_id = NULL")).
		WithArgs("-1_456000001", "queued", sqlmock.AnyArg(), "batch submit: 400 usage limits").WillReturnResult(sqlmock.NewResult(0, 1))
	if failed := r.submit(context.Background(), []pending{readyVideo("-1_456000001")}); failed != 1 {
		t.Fatalf("failed %d", failed)
	}
}

// syncClient is a synchronous transport (AI_CLIENT=messages, the manual run) with a canned answer.
type syncClient struct {
	res detector.Result
	err error
}

func (c syncClient) Model() string { return "claude-sonnet-5-5" }
func (c syncClient) Detect(context.Context, detector.Request) (detector.Result, error) {
	return c.res, c.err
}

func TestSyncCallErrorDropsTheRunAndSpendsNoAttempt(t *testing.T) {
	r, mock, _ := batchRun(t)
	r.batch, r.client = nil, syncClient{err: errors.New("429 rate limited\nretry later")}
	expectStartRun(mock, "-1_456000001", 11)
	mock.ExpectExec(regexp.QuoteMeta("DELETE FROM prv_ai_runs WHERE id = $1")).WithArgs(11).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, next_attempt_at = $3, last_error = $4, batch_id = NULL")).
		WithArgs("-1_456000001", "queued", sqlmock.AnyArg(), "detect call: 429 rate limited: retry later").WillReturnResult(sqlmock.NewResult(0, 1))
	if failed := r.submit(context.Background(), []pending{readyVideo("-1_456000001")}); failed != 1 {
		t.Fatalf("failed %d", failed)
	}
}

// An answer that came back unusable was paid for: the video fails, as before, or it would be bought again every hour.
func TestSyncUnusableAnswerFailsTheVideo(t *testing.T) {
	r, mock, _ := batchRun(t)
	r.batch, r.client = nil, syncClient{res: detector.Result{Usage: detector.Usage{InputTokens: 10000, OutputTokens: 64000}},
		err: errors.New("stop_reason max_tokens")}
	expectStartRun(mock, "-1_456000001", 11)
	expectPublishBegin(mock)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE")).WithArgs("-1_456000001").
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("detecting"))
	mock.ExpectExec("UPDATE prv_ai_runs SET raw_output").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, last_error = $3")).
		WithArgs("-1_456000001", "failed", "stop_reason max_tokens").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if failed := r.submit(context.Background(), []pending{readyVideo("-1_456000001")}); failed != 0 {
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
			r.prv = testPrv
			mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = $2, attempts = $3")).
				WithArgs("-1_456000001", c.status, 1, sqlmock.AnyArg(), c.lastErr).WillReturnResult(sqlmock.NewResult(0, 1))
			q := queued{nativeID: "-1_456000001", viewsMax: sql.NullInt64{Int64: 20000, Valid: true}}
			if failed := r.detect(context.Background(), []queued{q}); failed != 0 {
				t.Fatalf("failed = %d, want 0: one failed fetch is the video's", failed)
			}
		})
	}
}

func TestDetectEveryFetchFailedIsTheHosts(t *testing.T) {
	r, _, _ := batchRun(t)
	r.ytdlp = stubYtdlp(t, "")
	r.prv = testPrv
	claimed := []queued{
		{nativeID: "-1_456000001", viewsMax: sql.NullInt64{Int64: 20000, Valid: true}},
		{nativeID: "-1_456000002", viewsMax: sql.NullInt64{Int64: 20000, Valid: true}},
	}
	// No UPDATE expected: no attempt spent, the rows stay `fetching`.
	if failed := r.detect(context.Background(), claimed); failed != 2 {
		t.Fatalf("failed = %d, want 2", failed)
	}
}

func TestAPIErrorAddsOpenAIBody(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", &openai.Error{StatusCode: 400, Code: "billing_hard_limit_reached", Message: "limit"})
	if got, want := apiError(err), "wrapped: OpenAI API error: 400 Bad Request (billing_hard_limit_reached: limit)"; got != want {
		t.Errorf("apiError = %q, want %q", got, want)
	}
	if got := apiError(errors.New("plain")); got != "plain" {
		t.Errorf("apiError = %q, want plain", got)
	}
}
