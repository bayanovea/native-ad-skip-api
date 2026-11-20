package pipeline

import (
	"context"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/budget"
	"odedohbest/video-calculate/ai/detector"
)

var testNow = time.Date(2026, 11, 19, 10, 0, 0, 0, time.UTC)

type haikuSecond struct{ fakeSecond }

func (*haikuSecond) Model() string { return "claude-haiku-5-5" }

// The stored run: two first-model sponsors, cues 1 (10–40 s) and 3 (60–90 s).
const (
	backlogRaw = `{"segments":[{"category":"sponsor","first_cue":1,"last_cue":1,"confidence":"high","quote":"b"},` +
		`{"category":"sponsor","first_cue":3,"last_cue":3,"confidence":"high","quote":"d"}]}`
	backlogTranscript = `{"meta":{},"cues":[{"start":0,"end":10,"text":"a"},{"start":10,"end":40,"text":"b"},` +
		`{"start":40,"end":60,"text":"c"},{"start":60,"end":90,"text":"d"}]}`
)

func backlogRun(t *testing.T, cap float64) (*detectRun, sqlmock.Sqlmock, *haikuSecond) {
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
	second := &haikuSecond{fakeSecond{res: segs(seg("sponsor", 1, 1))}}
	r := &detectRun{db: db, second: second, secondPrice: detector.Prices["claude-haiku-5-5"],
		categories: map[string]int{"sponsor": 2, "self_promotion": 3}, prv: testPrv,
		budget: testBudget(budget.Anthropic, cap, 0, 0.004)}
	return r, mock, second
}

// The backlog: published, not withdrawn, of a detector of another vendor than the second model
// (Haiku: Anthropic, so $1 = true), no confirmation row; newest first, ten a tick.
func expectBacklog(mock sqlmock.Sqlmock, videoIDs ...int) {
	rows := sqlmock.NewRows([]string{"video_id", "native_id", "run_id", "raw_output", "transcript"})
	for _, id := range videoIDs {
		rows.AddRow(id, "-1_456000001", int64(11), []byte(backlogRaw), []byte(backlogTranscript))
	}
	mock.ExpectQuery(regexp.QuoteMeta(`FROM prv_ai_video_calculateds a JOIN prv_ai_runs r ON r.id = a.run_id
	WHERE a.withdrawn_at IS NULL AND a.data <> '[]' AND (r.model LIKE 'claude-%') <> $1`) +
		`(?s).*NOT EXISTS \(SELECT 1 FROM prv_ai_confirmations c WHERE c.run_id = a.run_id\)\s+ORDER BY a.published_at DESC, a.video_id LIMIT 10`).
		WithArgs(true).WillReturnRows(rows)
}

func expectBacklogLeft(mock sqlmock.Sqlmock, n int) {
	mock.ExpectQuery(`SELECT COUNT\(\*\) FROM prv_ai_video_calculateds a`).WithArgs(true).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(n))
}

// expectLockedRow is confirmLater's transaction up to the AI row: publishLock, video_calculateds, the row.
func expectLockedRow(mock sqlmock.Sqlmock, data, hidden string, withdrawn any) {
	expectPublishBegin(mock)
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT data, hidden, run_id, withdrawn_at FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"data", "hidden", "run_id", "withdrawn_at"}).AddRow([]byte(data), []byte(hidden), int64(11), withdrawn))
}

func expectKeeps(mock sqlmock.Sqlmock, bounds ...[2]int) {
	rows := sqlmock.NewRows([]string{"start", "end", "decided_at"})
	for _, b := range bounds {
		rows.AddRow(b[0], b[1], testNow)
	}
	mock.ExpectQuery(`k.verdict IN \('sponsor', 'self_promotion'\)`).WillReturnRows(rows)
}

func expectDItem(mock sqlmock.Sqlmock, start, end int) {
	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM prv_review_items WHERE COALESCE(sheet, batch) = $1")).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WillReturnRows(sqlmock.NewRows([]string{"batch"}))
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_batches").WithArgs(sqlmock.AnyArg(), "important").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), "D1", 1, "-1_456000001", start, end, "sponsor", sqlmock.AnyArg(), sqlmock.AnyArg(),
			[]byte(`["second claude-haiku-5-5: not found","entry: sponsor high, 30 s"]`), 7).
		WillReturnResult(sqlmock.NewResult(1, 1))
}

func expectConfirmation(mock sqlmock.Sqlmock, errText, confirmed, unconfirmed, extra any) {
	mock.ExpectExec("INSERT INTO prv_ai_confirmations").
		WithArgs(int64(11), 7, "-1_456000001", "claude-haiku-5-5", "", sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), errText, confirmed, unconfirmed, extra).
		WillReturnResult(sqlmock.NewResult(0, 1))
}

const (
	sponsor1040 = `{"category_id":2,"start":10,"end":40,"confidence":"high","source":"ai"}`
	sponsor6090 = `{"category_id":2,"start":60,"end":90,"confidence":"high","source":"ai","rating":-1}`
	hiddenShort = `{"category_id":3,"start":40,"end":43,"confidence":"high","source":"ai","reason":"short"}`
)

// The second model finds the 10–40 sponsor, not the 60–90 one: that entry moves to hidden as
// unconfirmed without its rating and gets a D item; the hidden short entry stays where it was.
func TestBacklogHidesTheUnconfirmedEntry(t *testing.T) {
	r, mock, second := backlogRun(t, 1)
	expectBacklog(mock, 7)
	expectLockedRow(mock, `[`+sponsor1040+`,`+sponsor6090+`]`, `[`+hiddenShort+`]`, nil)
	expectKeeps(mock)
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3")).
		WithArgs(7, []byte(`[`+sponsor1040+`]`),
			[]byte(`[`+hiddenShort+`,{"category_id":2,"start":60,"end":90,"confidence":"high","source":"ai","reason":"unconfirmed"}]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	expectConfirmation(mock, nil, 1, 1, 0)
	expectDItem(mock, 60, 90)
	mock.ExpectCommit()
	expectBacklogLeft(mock, 41)

	if left, err := r.confirmBacklog(context.Background()); left != 41 || err != nil || second.calls != 1 {
		t.Fatalf("got %d %v, %d calls", left, err, second.calls)
	}
}

// An entry an assessor kept, or whose bounds a verdict set, stays served; the row counts it unconfirmed.
func TestBacklogKeepsReviewedEntries(t *testing.T) {
	r, mock, second := backlogRun(t, 1)
	second.res = segs()
	reviewed := `{"category_id":2,"start":58,"end":95,"confidence":"high","source":"review"}`
	expectBacklog(mock, 7)
	expectLockedRow(mock, `[`+sponsor1040+`,`+reviewed+`]`, `[]`, nil)
	expectKeeps(mock, [2]int{10, 40})
	expectConfirmation(mock, nil, 0, 2, 0)
	mock.ExpectCommit()
	expectBacklogLeft(mock, 0)

	if _, err := r.confirmBacklog(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// A chapter-moved entry is matched to its prediction by overlap and stays served at the chapter's bounds;
// a row whose every served entry is unconfirmed serves nothing and is not withdrawn.
func TestBacklogMatchesMovedEntriesAndLeavesARowEmpty(t *testing.T) {
	r, mock, _ := backlogRun(t, 1)
	chapter := `{"category_id":2,"start":12,"end":38,"confidence":"high","source":"chapter"}`
	expectBacklog(mock, 7)
	expectLockedRow(mock, `[`+chapter+`]`, `[]`, nil)
	expectKeeps(mock)
	expectConfirmation(mock, nil, 1, 0, 0)
	mock.ExpectCommit()
	expectBacklogLeft(mock, 0)
	if _, err := r.confirmBacklog(context.Background()); err != nil {
		t.Fatal(err)
	}

	r, mock, second := backlogRun(t, 1)
	second.res = segs(seg("self_promotion", 1, 1))
	expectBacklog(mock, 7)
	expectLockedRow(mock, `[`+sponsor6090+`]`, `[]`, nil)
	expectKeeps(mock)
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3")).
		WithArgs(7, []byte(`[]`), []byte(`[{"category_id":2,"start":60,"end":90,"confidence":"high","source":"ai","reason":"unconfirmed"}]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	expectConfirmation(mock, nil, 0, 1, 1)
	expectDItem(mock, 60, 90)
	mock.ExpectCommit()
	expectBacklogLeft(mock, 0)
	if _, err := r.confirmBacklog(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// A row withdrawn between the call and the transaction is left alone: nothing written.
func TestBacklogSkipsARowWithdrawnMeanwhile(t *testing.T) {
	r, mock, _ := backlogRun(t, 1)
	expectBacklog(mock, 7)
	expectLockedRow(mock, `[`+sponsor1040+`]`, `[]`, testNow)
	mock.ExpectRollback()
	expectBacklogLeft(mock, 1)
	if left, err := r.confirmBacklog(context.Background()); left != 1 || err != nil {
		t.Fatalf("got %d %v", left, err)
	}
}

// Past the cap no call is made; the backlog waits for the next day.
func TestBacklogStopsAtTheCap(t *testing.T) {
	r, mock, second := backlogRun(t, 0.005)
	expectBacklog(mock, 7, 8)
	expectLockedRow(mock, `[`+sponsor1040+`]`, `[]`, nil)
	expectKeeps(mock)
	expectConfirmation(mock, nil, 1, 0, 0)
	mock.ExpectCommit()
	expectBacklogLeft(mock, 1)
	second.res.Usage = detector.Usage{InputTokens: 20_000} // $0.002: 0.002 left, under the 0.004 average
	if left, err := r.confirmBacklog(context.Background()); left != 1 || err != nil || second.calls != 1 {
		t.Fatalf("got %d %v, %d calls", left, err, second.calls)
	}
}

// No answer (a 529): nothing written, the row stays in the backlog; an answer that does not
// validate writes its confirmation row with the error and changes no entry.
func TestBacklogFailedCalls(t *testing.T) {
	r, mock, second := backlogRun(t, 1)
	second.res, second.err = detector.Result{}, errors.New("529 overloaded_error")
	expectBacklog(mock, 7)
	expectBacklogLeft(mock, 1)
	if left, err := r.confirmBacklog(context.Background()); left != 1 || err != nil {
		t.Fatalf("529: got %d %v", left, err)
	}

	r, mock, second = backlogRun(t, 1)
	second.res = segs(seg("sponsor", 2, 9))
	expectBacklog(mock, 7)
	expectLockedRow(mock, `[`+sponsor1040+`]`, `[]`, nil)
	expectConfirmation(mock, sqlmock.AnyArg(), nil, nil, nil)
	mock.ExpectCommit()
	expectBacklogLeft(mock, 0)
	if left, err := r.confirmBacklog(context.Background()); left != 0 || err != nil {
		t.Fatalf("invalid: got %d %v", left, err)
	}
}

// With the second model at OpenAI, the backlog is the Anthropic detectors' rows ($1 = false).
func TestBacklogOfAnOpenAISecondModel(t *testing.T) {
	r, mock, _ := backlogRun(t, 1)
	r.second = &fakeSecond{}
	mock.ExpectQuery(`LIMIT 10`).WithArgs(false).WillReturnRows(sqlmock.NewRows([]string{"video_id", "native_id", "run_id", "raw_output", "transcript"}))
	mock.ExpectQuery(`SELECT COUNT\(\*\)`).WithArgs(false).WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	if _, err := r.confirmBacklog(context.Background()); err != nil {
		t.Fatal(err)
	}
}
