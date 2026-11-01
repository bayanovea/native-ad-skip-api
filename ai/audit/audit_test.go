package audit

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
	"github.com/lib/pq"

	"odedohbest/video-calculate/ai/detector"
)

type fakeLLM struct {
	raw   string
	err   error
	calls int
}

func (f *fakeLLM) Model() string { return "claude-sonnet-5-5" }

func (f *fakeLLM) Audit(context.Context, detector.Request) (llmResult, error) {
	f.calls++
	return llmResult{Raw: f.raw, Usage: detector.Usage{InputTokens: 10000, OutputTokens: 100}}, f.err
}

func newRun(t *testing.T, llm llmClient, status int) (*auditRun, sqlmock.Sqlmock, *int) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	sent := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sent++
		w.WriteHeader(status)
		if status == http.StatusOK {
			w.Write([]byte(`{"ok":true}`))
		} else {
			w.Write([]byte(`{"ok":false}`))
		}
	}))
	t.Cleanup(srv.Close)
	return &auditRun{db: db, llm: llm, prompt: detector.Prompt{Text: "audit", SHA: "abc"}, price: detector.Prices["claude-sonnet-5-5"],
		tg: newTelegram(Config{TelegramURL: srv.URL, BotToken: "T", ChatID: "1"})}, mock, &sent
}

// expectRead: readBatch of a judge batch with one item, kept by Gam (verdict id 41).
func expectRead(mock sqlmock.Sqlmock, batch string) {
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT b.reviews_needed`).WithArgs(batch).
		WillReturnRows(sqlmock.NewRows([]string{"reviews_needed", "finished"}).AddRow(1, pq.StringArray{"Gam"}))
	mock.ExpectQuery(`FROM prv_review_items WHERE batch = \$1`).WithArgs(batch).
		WillReturnRows(sqlmock.NewRows([]string{"id", "item_code", "kind", "sheet", "native_id", "video_id", "start", "end", "proposed", "cues", "flagged_by"}).
			AddRow(1, "A1", "ai", "ai-judge-2026-11-01", "-1_1", 7, 10.0, 40.0, "sponsor", "текст", []byte(`["judge review by rules: duration","signals: x"]`)))
	mock.ExpectQuery(`FROM prv_review_verdicts v JOIN prv_review_items i`).WithArgs(batch).
		WillReturnRows(sqlmock.NewRows([]string{"id", "item_id", "verdict", "comment", "reviewer", "start", "end", "decided_at"}).
			AddRow(41, 1, "sponsor", "", "Gam", nil, nil, time.Now().Add(-time.Hour)))
	mock.ExpectQuery(`FROM prv_review_video_flags`).WillReturnRows(sqlmock.NewRows([]string{"native_id", "value"}))
	mock.ExpectRollback()
}

func TestAuditRecordsAndNotifies(t *testing.T) {
	llm := &fakeLLM{raw: `{"summary":"Всё подтверждено.","findings":[]}`}
	r, mock, sent := newRun(t, llm, http.StatusOK)
	expectRead(mock, "ai-judge-2026-11-01")
	mock.ExpectQuery(`SELECT findings FROM prv_review_audits WHERE batch = \$1`).WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`INSERT INTO prv_review_audits`).
		WithArgs("ai-judge-2026-11-01", 41, 1, sqlmock.AnyArg(), sqlmock.AnyArg(), "Всё подтверждено.", "claude-sonnet-5-5", "abc",
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), "").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(5))
	mock.ExpectExec(`UPDATE prv_review_audits SET notified_at = NOW\(\) WHERE id = \$1`).WithArgs(5).WillReturnResult(sqlmock.NewResult(0, 1))
	if err := r.audit("ai-judge-2026-11-01"); err != nil {
		t.Fatal(err)
	}
	if *sent != 1 || llm.calls != 1 {
		t.Fatalf("sent %d, calls %d", *sent, llm.calls)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAuditTransportErrorWritesNothing(t *testing.T) {
	r, mock, sent := newRun(t, &fakeLLM{err: errors.New("overloaded")}, http.StatusOK)
	expectRead(mock, "b")
	if err := r.audit("b"); err == nil || !strings.Contains(err.Error(), "overloaded") {
		t.Fatalf("err = %v", err)
	}
	if *sent != 0 {
		t.Fatal("sent")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAuditInvalidAnswerKeepsRuleFindings(t *testing.T) {
	r, mock, _ := newRun(t, &fakeLLM{raw: "stop_reason max_tokens: {"}, http.StatusOK)
	expectRead(mock, "b")
	// The previous audit already had the false alarm: nothing new, so no message.
	mock.ExpectQuery(`SELECT findings FROM prv_review_audits`).
		WillReturnRows(sqlmock.NewRows([]string{"findings"}).AddRow([]byte(`[{"kind":"judge_false_alarm","items":["A1"]}]`)))
	mock.ExpectQuery(`INSERT INTO prv_review_audits`).
		WithArgs("b", 41, 1, sqlmock.AnyArg(), sqlmock.AnyArg(), "", "claude-sonnet-5-5", "abc", sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg()).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(6))
	if err := r.audit("b"); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestTickCountsFailedSendAndBatch(t *testing.T) {
	r, mock, sent := newRun(t, &fakeLLM{err: errors.New("down")}, http.StatusInternalServerError)
	mock.ExpectQuery(`WHERE notified_at IS NULL`).WithArgs(window.Seconds()).
		WillReturnRows(sqlmock.NewRows([]string{"id", "batch", "summary", "findings"}).
			AddRow(3, "old", "", []byte(`[{"kind":"precision","severity":"owner","items":["S1"],"text":"x","new":true}]`)))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT s.batch FROM s`)).WithArgs(OwnerReviewer, window.Seconds(), settle.Seconds()).
		WillReturnRows(sqlmock.NewRows([]string{"batch"}).AddRow("b"))
	expectRead(mock, "b")
	failed, err := r.tick()
	if err != nil || failed != 2 || *sent != 1 {
		t.Fatalf("failed %d, err %v, sent %d", failed, err, *sent)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestReadBatchRefusesUnfinished(t *testing.T) {
	r, mock, _ := newRun(t, &fakeLLM{}, http.StatusOK)
	mock.ExpectBegin()
	mock.ExpectQuery(`SELECT b.reviews_needed`).WithArgs("b").
		WillReturnRows(sqlmock.NewRows([]string{"reviews_needed", "finished"}).AddRow(2, pq.StringArray{"Gam"}))
	mock.ExpectRollback()
	if err := r.audit("b"); !errors.Is(err, errNotFinished) {
		t.Fatalf("err = %v", err)
	}
}

func TestTelegramOffAuditsWithoutSending(t *testing.T) {
	r, mock, sent := newRun(t, &fakeLLM{raw: `{"summary":"","findings":[]}`}, http.StatusInternalServerError)
	r.tg = nil
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT s.batch FROM s`)).WillReturnRows(sqlmock.NewRows([]string{"batch"}).AddRow("b"))
	expectRead(mock, "b")
	mock.ExpectQuery(`SELECT findings FROM prv_review_audits`).WillReturnError(sql.ErrNoRows)
	mock.ExpectQuery(`INSERT INTO prv_review_audits`).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7))
	failed, err := r.tick()
	if err != nil || failed != 0 || *sent != 0 {
		t.Fatalf("failed %d, err %v, sent %d", failed, err, *sent)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDueSQLBounds(t *testing.T) {
	for _, want := range []string{"s.locked_by IS NULL", "cardinality(s.finished) >= s.reviews_needed", "f <> $1",
		"NOW() - make_interval(secs => $2) AND NOW() - make_interval(secs => $3)", "s.watermark > COALESCE"} {
		if !strings.Contains(dueSQL, want) {
			t.Errorf("dueSQL lacks %q", want)
		}
	}
	if window != 7*24*time.Hour || settle != 30*time.Minute {
		t.Fatal("window / settle")
	}
}
