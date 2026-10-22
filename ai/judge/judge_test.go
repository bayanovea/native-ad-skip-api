package judge

import (
	"context"
	"database/sql"
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

// A video judged 7 h ago whose undo counter moved from 1 to 2: the rules want the LLM.
func llmCase(t *testing.T, raw string, autoWithdraw bool) (*run, sqlmock.Sqlmock, Video, *fakeLLM) {
	db, mock := newMock(t)
	llm := &fakeLLM{raw: raw}
	r := &run{cfg: Config{AutoWithdraw: autoWithdraw, MinInterval: 6 * time.Hour}, db: db, categories: testCategories,
		llm: llm, prompt: detector.Prompt{Text: "judge"}, price: detector.Prices["claude-sonnet-5-5"], now: published.Add(32 * time.Hour)}
	v := testVideo
	v.JudgedAt = sql.NullTime{Time: published.Add(25 * time.Hour), Valid: true}
	v.JudgeCounters = []byte(`{"undo":1}`)
	expectSignals(mock, 2, 0)
	return r, mock, v, llm
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
	mock.ExpectQuery("SELECT EXISTS").WithArgs(7).WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
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

func expectCounters(mock sqlmock.Sqlmock) {
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET judged_at = NOW(), judge_counters = $2")).
		WithArgs("-1_456000001", []byte(`{"votes_up":0,"votes_down":0,"undo":2,"clicks":0,"human_markups":0,"conflicting_markups":0,"duration_variants":0,"duration_recut":0}`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
}

const cost = 10000*2.0/1e6 + 100*10.0/1e6

func TestJudgeVideoSkipsAJudgedVideoWhoseCountersDidNotMove(t *testing.T) {
	r, _, v, llm := llmCase(t, "", true)
	v.JudgeCounters = []byte(`{"undo":2}`)
	if err := r.judgeVideo(v); err != nil || llm.calls != 0 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoCallsTheLLMAtMostOncePerMinInterval(t *testing.T) {
	r, _, v, llm := llmCase(t, "", true)
	r.now = published.Add(30 * time.Hour) // 5 h after the last judgement
	if err := r.judgeVideo(v); err != nil || llm.calls != 0 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoLLMReviewKeepsTheRowAndCreatesItems(t *testing.T) {
	r, mock, v, llm := llmCase(t, `{"decision":"review","reason":"undo on the entry","segments":[{"index":0,"keep":true}]}`, true)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "review", "llm", "undo on the entry", "claude-sonnet-5-5", cost)
	expectNewItems(mock, `["judge review by llm: undo on the entry","signals: undo=2","keep: true"]`)
	expectCounters(mock)
	if err := r.judgeVideo(v); err != nil || llm.calls != 1 {
		t.Fatal(err, llm.calls)
	}
}

func TestJudgeVideoLLMWithdraw(t *testing.T) {
	for _, auto := range []bool{true, false} {
		r, mock, v, _ := llmCase(t, `{"decision":"withdraw","reason":"not an ad","segments":[{"index":0,"keep":false}]}`, auto)
		expectTranscript(mock)
		expectLockAndJudgement(mock, "withdraw", "llm", "not an ad", "claude-sonnet-5-5", cost)
		if auto {
			mock.ExpectExec(regexp.QuoteMeta("SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3")).WithArgs(7, "judge", "not an ad").
				WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = 'withdrawn'")).WillReturnResult(sqlmock.NewResult(0, 1))
		}
		expectNewItems(mock, `["judge withdraw by llm: not an ad","signals: undo=2","keep: false"]`)
		expectCounters(mock)
		if err := r.judgeVideo(v); err != nil {
			t.Fatalf("auto withdraw %v: %v", auto, err)
		}
	}
}

func TestJudgeVideoLLMOkRecordsOnly(t *testing.T) {
	r, mock, v, _ := llmCase(t, `{"decision":"ok","reason":"one undo of many views","segments":[]}`, true)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "ok", "llm", "one undo of many views", "claude-sonnet-5-5", cost)
	expectCounters(mock)
	if err := r.judgeVideo(v); err != nil {
		t.Fatal(err)
	}
}

func TestJudgeVideoInvalidAnswerGoesToAHuman(t *testing.T) {
	r, mock, v, _ := llmCase(t, `{"decision":"maybe","reason":"?","segments":[]}`, true)
	expectTranscript(mock)
	expectLockAndJudgement(mock, "review", "rules", `judge_invalid: unknown decision "maybe"`, "claude-sonnet-5-5", cost)
	expectNewItems(mock, `["judge review by rules: judge_invalid: unknown decision \"maybe\"","signals: undo=2"]`)
	expectCounters(mock)
	if err := r.judgeVideo(v); err != nil {
		t.Fatal(err)
	}
}

func TestJudgeVideoFailedCallRecordsNothing(t *testing.T) {
	r, mock, v, llm := llmCase(t, "", true)
	llm.err = errors.New("529 overloaded")
	expectTranscript(mock)
	if err := r.judgeVideo(v); err == nil {
		t.Fatal("want the call's error")
	}
}

func TestJudgeVideoWithdrawsARecutWithoutTheLLM(t *testing.T) {
	db, mock := newMock(t)
	llm := &fakeLLM{}
	r := &run{cfg: Config{AutoWithdraw: false}, db: db, categories: testCategories, llm: llm, now: published.Add(30 * time.Hour)}
	expectSignals(mock, 0, 1)
	expectLockAndJudgement(mock, "withdraw", "rules", sqlmock.AnyArg(), nil, nil)
	mock.ExpectExec(regexp.QuoteMeta("withdrawn_by = $2")).WithArgs(7, "duration", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_videos SET status = 'withdrawn'")).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("judged_at = NOW()").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()
	if err := r.judgeVideo(testVideo); err != nil || llm.calls != 0 {
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
