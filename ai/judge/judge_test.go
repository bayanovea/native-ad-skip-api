package judge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/detector"
)

type fakeLLM struct {
	raw   string
	err   error
	calls int
}

func (f *fakeLLM) Model() string { return "claude-sonnet-5-5" }

func (f *fakeLLM) Judge(_ context.Context, req detector.Request) (llmResult, error) {
	f.calls++
	return llmResult{Raw: f.raw, Usage: detector.Usage{InputTokens: 10000, OutputTokens: 100}}, f.err
}

var judgeNow = published.Add(32 * time.Hour)

// A video judged 7 h ago (at `since`), with no expectations set yet.
func llmCase(t *testing.T, raw string, autoWithdraw bool) (*run, sqlmock.Sqlmock, Video, *fakeLLM) {
	db, mock := newMock(t)
	llm := &fakeLLM{raw: raw}
	r := &run{cfg: Config{AutoWithdraw: autoWithdraw, MinInterval: 6 * time.Hour}, db: db, categories: testCategories,
		llm: llm, prompt: detector.Prompt{Text: "judge"}, price: detector.Prices["claude-sonnet-5-5"], now: judgeNow}
	v := testVideo
	v.JudgedAt = sql.NullTime{Time: since, Valid: true}
	return r, mock, v, llm
}

// llmCaseNotKept is llmCase for a video no human has kept since its last judgement, with two
// undo events, one of them after it: the rules want the LLM.
func llmCaseNotKept(t *testing.T, raw string, autoWithdraw bool) (*run, sqlmock.Sqlmock, Video, *fakeLLM) {
	r, mock, v, llm := llmCase(t, raw, autoWithdraw)
	expectNotKept(mock, r.now)
	return r, mock, v, llm
}

func expectNotKept(mock sqlmock.Sqlmock, now time.Time) {
	expectKept(mock, since, nil)
	expectSignals(mock, since, now, [2]int{}, [2]int{2, 1}, 0)
}

// expectKept: entryKeeps' answer for testVideo judged at `judged`, its one entry's keep verdict time or nil.
func expectKept(mock sqlmock.Sqlmock, judged time.Time, keptAt any) {
	rows := sqlmock.NewRows([]string{"start", "end", "decided_at"})
	if keptAt != nil {
		rows.AddRow(30, 70, keptAt)
	}
	mock.ExpectQuery(`(?s)i.kind = 'ai' AND i.video_id = \$1.*ORDER BY r.decided_at DESC, r.id DESC LIMIT 1.*`+
		regexp.QuoteMeta(`WHERE l.verdict IN ('sponsor', 'self_promotion') AND l.decided_at > $3`)).
		WithArgs(7, testVideo.Data, judged).WillReturnRows(rows)
}

func expectTranscript(mock sqlmock.Sqlmock) {
	mock.ExpectQuery(regexp.QuoteMeta("SELECT r.transcript FROM prv_ai_video_calculateds a JOIN prv_ai_runs r")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"transcript"}).AddRow([]byte(`{"meta":{},"cues":[{"start":31,"end":35,"text":"спонсор выпуска"}]}`)))
}

func expectLockAndJudgement(mock sqlmock.Sqlmock, decision, by string, reason any, model, cost any) {
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT withdrawn_at FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"withdrawn_at"}).AddRow(nil))
	mock.ExpectExec(regexp.QuoteMeta(`INSERT INTO prv_ai_judgements (video_id, decision, "by", reason, signals, model, cost_usd) VALUES ($1, $2, $3, $4, $5, $6, $7)`)).
		WithArgs(7, decision, by, reason, sqlmock.AnyArg(), model, cost).WillReturnResult(sqlmock.NewResult(1, 1))
}

// expectNewItems: no open item, a fresh sheet, one item for the one entry.
func expectNewItems(mock sqlmock.Sqlmock, flagged string) {
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT i.start, i."end" FROM prv_review_items i`)).WithArgs(7).WillReturnRows(sqlmock.NewRows([]string{"start", "end"}))
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WithArgs("ai-judge-2026-10-21").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(0))
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO prv_review_batches (batch) VALUES ($1) ON CONFLICT DO NOTHING")).WithArgs("ai-judge-2026-10-21").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-judge-2026-10-21", "ai-judge-2026-10-21", "A1", 1, "-1_456000001", 30, 70, "sponsor", "спонсор выпуска",
			"https://example.invalid/video-1_456000001?t=28s", []byte(flagged), 7).
		WillReturnResult(sqlmock.NewResult(1, 1))
}

// expectCounters: judged_at moves to the tick's start, the counters (two undo events) are recorded.
func expectCounters(mock sqlmock.Sqlmock, now time.Time) {
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET judged_at = $3, judge_counters = $2")).
		WithArgs("-1_456000001", []byte(`{"votes_up":0,"votes_down":0,"undo":2,"clicks":0,"human_markups":0,"conflicting_markups":0,"duration_variants":0,"duration_recut":0}`), now).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
}

const cost = 10000*2.0/1e6 + 100*10.0/1e6

func TestJudgeVideoSkipsAJudgedVideoWithNoNewEvidence(t *testing.T) {
	r, mock, v, llm := llmCase(t, "", true)
	v.JudgeCounters = []byte(`{"duration_recut":1}`)
	expectKept(mock, since, nil)
	expectSignals(mock, since, r.now, [2]int{3, 0}, [2]int{2, 0}, 1) // old negatives and an old re-cut
	if err := r.judgeVideo(v); err != nil || llm.calls != 0 {
		t.Fatal(err, llm.calls)
	}
}

// Entry A's three dislikes went with A (removed on review) and B got two new ones: the total
// fell from 3 to 2, the two are new all the same.
func TestJudgeVideoNewDownVotesReachTheLLMWhenTheTotalShrank(t *testing.T) {
	r, mock, v, llm := llmCase(t, `{"decision":"ok","reason":"fine","segments":[{"index":0,"keep":true}]}`, true)
	expectKept(mock, since, nil)
	expectSignals(mock, since, r.now, [2]int{2, 2}, [2]int{}, 0)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "ok", "llm", "fine", "claude-sonnet-5-5", cost)
	mock.ExpectExec("judged_at = \\$3").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoCallsTheLLMAtMostOncePerMinInterval(t *testing.T) {
	r, mock, v, llm := llmCase(t, "", true)
	r.now = published.Add(30 * time.Hour) // 5 h after the last judgement
	expectNotKept(mock, r.now)
	if err := r.judgeVideo(v); err != nil || llm.calls != 0 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoLLMReviewKeepsTheRowAndCreatesItems(t *testing.T) {
	r, mock, v, llm := llmCaseNotKept(t, `{"decision":"review","reason":"undo on the entry","segments":[{"index":0,"keep":true}]}`, true)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "review", "llm", "undo on the entry", "claude-sonnet-5-5", cost)
	expectNewItems(mock, `["judge review by llm: undo on the entry","signals: undo=2","keep: true"]`)
	expectCounters(mock, r.now)
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoLLMWithdraw(t *testing.T) {
	for _, auto := range []bool{true, false} {
		r, mock, v, _ := llmCaseNotKept(t, `{"decision":"withdraw","reason":"not an ad","segments":[{"index":0,"keep":false}]}`, auto)
		expectTranscript(mock)
		expectLockAndJudgement(mock, "withdraw", "llm", "not an ad", "claude-sonnet-5-5", cost)
		if auto {
			mock.ExpectExec(regexp.QuoteMeta("SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3")).WithArgs(7, "judge", "not an ad").
				WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = 'withdrawn' WHERE native_id = $1")).WithArgs("-1_456000001").
				WillReturnResult(sqlmock.NewResult(0, 1))
		}
		expectNewItems(mock, `["judge withdraw by llm: not an ad","signals: undo=2","keep: false"]`)
		expectCounters(mock, r.now)
		if err := r.judgeVideo(v); err != nil {
			t.Fatalf("auto withdraw %v: %v", auto, err)
		}
	}
}

func TestJudgeVideoLLMOkRecordsOnly(t *testing.T) {
	r, mock, v, _ := llmCaseNotKept(t, `{"decision":"ok","reason":"one undo of many views","segments":[{"index":0,"keep":true}]}`, true)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "ok", "llm", "one undo of many views", "claude-sonnet-5-5", cost)
	expectCounters(mock, r.now)
	if err := r.judgeVideo(v); err != nil {
		t.Fatal(err)
	}
}

func TestJudgeVideoInvalidAnswerGoesToAHuman(t *testing.T) {
	r, mock, v, _ := llmCaseNotKept(t, `{"decision":"maybe","reason":"?","segments":[{"index":0,"keep":true}]}`, true)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "review", "rules", `judge_invalid: unknown decision "maybe"`, "claude-sonnet-5-5", cost)
	expectNewItems(mock, `["judge review by rules: judge_invalid: unknown decision \"maybe\"","signals: undo=2"]`)
	expectCounters(mock, r.now)
	if err := r.judgeVideo(v); err != nil {
		t.Fatal(err)
	}
}

func TestJudgeVideoFailedCallRecordsNothing(t *testing.T) {
	r, mock, v, llm := llmCaseNotKept(t, "", true)
	llm.err = errors.New("529 overloaded")
	expectTranscript(mock)
	if err := r.judgeVideo(v); err == nil {
		t.Fatal("want the call's error")
	}
}

// Judged 25 h after publish, every entry kept at 28 h, nothing created after the verdicts (a
// user repeating their dislike keeps their vote row): the tick records ok, so judged_at moves past the verdicts.
func TestJudgeVideoOkWhenEveryEntryWasKeptOnReviewSinceTheLastJudgement(t *testing.T) {
	r, mock, v, llm := llmCase(t, "", true)
	keptAt := published.Add(28 * time.Hour)
	expectKept(mock, since, keptAt)
	expectSignals(mock, keptAt, r.now, [2]int{}, [2]int{2, 0}, 0)
	expectLockAndJudgement(mock, "ok", "rules", "every entry kept on review since the last judgement", nil, nil)
	expectCounters(mock, r.now)
	if err := r.judgeVideo(v); err != nil || llm.calls != 0 {
		t.Fatal(err, llm.calls)
	}
}

// The same keep, but the second undo came after the verdicts: humans saw one undo, the LLM judges the new one.
func TestJudgeVideoCountsTheSignalsAfterAKeep(t *testing.T) {
	r, mock, v, llm := llmCase(t, `{"decision":"review","reason":"undo on the entry","segments":[{"index":0,"keep":true}]}`, true)
	keptAt := published.Add(28 * time.Hour)
	expectKept(mock, since, keptAt)
	expectSignals(mock, keptAt, r.now, [2]int{}, [2]int{2, 1}, 0)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "review", "llm", "undo on the entry", "claude-sonnet-5-5", cost)
	expectNewItems(mock, `["judge review by llm: undo on the entry","signals: undo=2","keep: true"]`)
	expectCounters(mock, r.now)
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoSendsARecutToReviewWithoutTheLLMOrAWithdraw(t *testing.T) {
	db, mock := newMock(t)
	llm := &fakeLLM{}
	r := &run{cfg: Config{AutoWithdraw: true}, db: db, categories: testCategories, llm: llm, now: reviewNow}
	expectSignals(mock, time.Time{}, reviewNow, [2]int{}, [2]int{}, 1)
	expectTranscript(mock)
	reason := "duration: 1 videos rows of another cut requested after publish"
	expectLockAndJudgement(mock, "review", "rules", reason, nil, nil)
	expectNewItems(mock, `["judge review by rules: `+reason+`","signals: duration_recut=1"]`)
	mock.ExpectExec("judged_at = \\$3").WithArgs("-1_456000001", sqlmock.AnyArg(), reviewNow).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := r.judgeVideo(testVideo); err != nil || llm.calls != 0 {
		t.Fatal(err, llm.calls)
	}
}

// An old re-cut (kept on review or not) never keeps later negative signals from the LLM and its withdraw.
func TestJudgeVideoNewNegativeSignalsAfterAnOldRecutReachTheLLM(t *testing.T) {
	db, mock := newMock(t)
	llm := &fakeLLM{raw: `{"decision":"withdraw","reason":"not an ad","segments":[{"index":0,"keep":false}]}`}
	r := &run{cfg: Config{AutoWithdraw: true, MinInterval: 6 * time.Hour}, db: db, categories: testCategories,
		llm: llm, prompt: detector.Prompt{Text: "judge"}, price: detector.Prices["claude-sonnet-5-5"], now: judgeNow}
	v := testVideo
	v.JudgedAt = sql.NullTime{Time: since, Valid: true}
	v.JudgeCounters = []byte(`{"undo":1,"duration_variants":1,"duration_recut":1}`)
	expectKept(mock, since, nil)
	expectSignals(mock, since, judgeNow, [2]int{}, [2]int{2, 1}, 1)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "withdraw", "llm", "not an ad", "claude-sonnet-5-5", cost)
	mock.ExpectExec(regexp.QuoteMeta("SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3")).WithArgs(7, "judge", "not an ad").
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = 'withdrawn' WHERE native_id = $1")).WithArgs("-1_456000001").
		WillReturnResult(sqlmock.NewResult(0, 1))
	expectNewItems(mock, `["judge withdraw by llm: not an ad","signals: undo=2 duration_recut=1","keep: false"]`)
	mock.ExpectExec("judged_at = \\$3").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

// A new re-cut that came with new negative signals: the LLM judges them, the re-cut still goes to a human.
func TestJudgeVideoNewRecutWithNegativeSignalsGoesToTheLLMAndAHuman(t *testing.T) {
	db, mock := newMock(t)
	llm := &fakeLLM{raw: `{"decision":"ok","reason":"fine","segments":[{"index":0,"keep":true}]}`}
	r := &run{cfg: Config{AutoWithdraw: true}, db: db, categories: testCategories,
		llm: llm, prompt: detector.Prompt{Text: "judge"}, price: detector.Prices["claude-sonnet-5-5"], now: reviewNow}
	expectSignals(mock, time.Time{}, reviewNow, [2]int{}, [2]int{2, 2}, 1)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "ok", "llm", "fine", "claude-sonnet-5-5", cost)
	expectNewItems(mock, `["judge ok by llm: fine","signals: undo=2 duration_recut=1","keep: true"]`)
	mock.ExpectExec("judged_at = \\$3").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := r.judgeVideo(testVideo); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

func TestConfigFromEnv(t *testing.T) {
	for _, k := range []string{"AI_JUDGE_ENABLED", "AI_JUDGE_AUTO_WITHDRAW", "AI_JUDGE_MODEL", "AI_JUDGE_MIN_INTERVAL", "AI_CLIENT", "AI_JUDGE_PROMPT"} {
		t.Setenv(k, "")
	}
	c, err := ConfigFromEnv()
	if err != nil || c.Enabled || !c.AutoWithdraw || c.Model != "claude-sonnet-5-5" || c.MinInterval != 6*time.Hour ||
		c.Client != "anthropic" || c.PromptPath != "/app/ai/prompts/judge-v1.md" {
		t.Fatalf("defaults: %+v %v", c, err)
	}
	t.Setenv("AI_JUDGE_AUTO_WITHDRAW", "off")
	t.Setenv("AI_JUDGE_MIN_INTERVAL", "0")
	if c, err = ConfigFromEnv(); err != nil || c.AutoWithdraw || c.MinInterval != 0 {
		t.Fatalf("got %+v %v", c, err)
	}
	t.Setenv("AI_JUDGE_MIN_INTERVAL", "6")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("a duration without a unit: want an error")
	}
}

func TestNewLLMClient(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	if _, err := newLLMClient("anthropic", "m", ""); err == nil {
		t.Fatal("no key: want an error")
	}
	if _, err := newLLMClient("batch", "m", ""); err == nil {
		t.Fatal("unknown client: want an error")
	}
	f, err := newLLMClient("fixture", "m", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Judge(context.Background(), detector.Request{Key: "-1_456000001"}); err == nil {
		t.Fatal("missing fixture: want an error")
	}
}

func TestJudgeVideoCallsTheLLMOnceTheMinIntervalHasPassed(t *testing.T) {
	r, mock, v, llm := llmCase(t, `{"decision":"ok","reason":"fine","segments":[{"index":0,"keep":true}]}`, true)
	r.now = v.JudgedAt.Time.Add(r.cfg.MinInterval) // exactly the interval
	expectNotKept(mock, r.now)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "ok", "llm", "fine", "claude-sonnet-5-5", cost)
	expectCounters(mock, r.now)
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

func TestRecordLeavesARowWithdrawnMeanwhile(t *testing.T) {
	db, mock := newMock(t)
	r := &run{db: db, categories: testCategories, now: reviewNow}
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT withdrawn_at FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"withdrawn_at"}).AddRow(reviewNow))
	mock.ExpectRollback()
	j := judgement{Decision: "withdraw", By: "llm", Reason: "r", WithdrawBy: "judge", Review: true}
	if err := r.record(testVideo, Signals{}, j, nil); err != nil {
		t.Fatal(err)
	}
}

func TestTickJudgesTheOtherVideosAfterAFailure(t *testing.T) {
	db, mock := newMock(t)
	r := &run{db: db, categories: testCategories, now: judgeNow}
	cols := []string{"video_id", "native_id", "data", "published_at", "duration", "judged_at", "judge_counters", "views_max", "requests", "last_seen_at"}
	mock.ExpectQuery("FROM prv_ai_video_calculateds a").WillReturnRows(sqlmock.NewRows(cols).
		AddRow(6, "-1_456000000", []byte(`not json`), published, 600, nil, nil, nil, 3, published).
		AddRow(7, "-1_456000001", testVideo.Data, published, 600, nil, nil, 25000, 12, testVideo.LastSeenAt))
	expectSignals(mock, time.Time{}, judgeNow, [2]int{}, [2]int{}, 0)
	expectLockAndJudgement(mock, "ok", "rules", "no negative signal", nil, nil)
	mock.ExpectExec("judged_at = \\$3").WithArgs("-1_456000001", sqlmock.AnyArg(), judgeNow).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if failed, err := r.tick(); failed != 1 || err != nil {
		t.Fatalf("got %d %v", failed, err)
	}
}

// Entry A kept at 26 h, B kept at 28 h, both after the last judgement (25 h): each entry's evidence
// counts after its own keep, and a conflicting markup at 27 h (after A's keep, before B's) is new.
func TestJudgeVideoBaselineIsPerEntry(t *testing.T) {
	r, mock, v, llm := llmCase(t, `{"decision":"ok","reason":"fine","segments":[{"index":0,"keep":true},{"index":1,"keep":true}]}`, true)
	v.Data = []byte(`[{"category_id":2,"start":30,"end":70},{"category_id":2,"start":200,"end":230}]`)
	keptA, keptB := published.Add(26*time.Hour), published.Add(28*time.Hour)
	mock.ExpectQuery("i.kind = 'ai'").WithArgs(7, v.Data, since).
		WillReturnRows(sqlmock.NewRows([]string{"start", "end", "decided_at"}).AddRow(30, 70, keptA).AddRow(200, 230, keptB))
	bounds, _ := json.Marshal([]baseline{{Entry{2, 30, 70}, keptA}, {Entry{2, 200, 230}, keptB}})
	mock.ExpectQuery("FROM votes").WithArgs(7, bounds, r.now).
		WillReturnRows(sqlmock.NewRows([]string{"up", "down", "new_down"}).AddRow(0, 0, 0))
	for _, table := range []string{"prv_events_interval_undo", "prv_events_interval_click"} {
		mock.ExpectQuery(table).WithArgs("-1_456000001", bounds, r.now).WillReturnRows(sqlmock.NewRows([]string{"count", "new"}).AddRow(0, 0))
	}
	mock.ExpectQuery("FROM markups").WithArgs(7, published, r.now).
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating", "dated"}).AddRow(2, 400.0, 430.0, 0, published.Add(27*time.Hour)))
	mock.ExpectQuery("FROM videos").WillReturnRows(sqlmock.NewRows([]string{"variants", "recut"}).AddRow(0, 0))
	expectTranscript(mock)
	expectLockAndJudgement(mock, "ok", "llm", "fine", "claude-sonnet-5-5", cost)
	mock.ExpectExec("judged_at = \\$3").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}
