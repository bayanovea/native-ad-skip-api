package pipeline

import (
	"context"
	"database/sql/driver"
	"errors"
	"reflect"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/vtt"
)

func TestAgree(t *testing.T) {
	first := []detector.Prediction{
		pred("sponsor", "high", 120, 180),        // the second's 125–185: IoU 55/65
		pred("sponsor", "high", 300, 360),        // the second has self_promotion here: another category
		pred("sponsor", "high", 500, 560),        // the second's 550–620: IoU 10/120
		pred("self_promotion", "high", 700, 720), // nothing near
		pred("sponsor", "high", 1000, 1040),      // the second's 1015–1055: IoU 25/55, the same ad cut differently
	}
	second := []detector.Prediction{
		pred("sponsor", "low", 125, 185),
		pred("self_promotion", "high", 300, 360),
		pred("sponsor", "high", 550, 620),
		pred("sponsor", "medium", 900, 960), // only the second found it
		pred("sponsor", "high", 1015, 1055),
	}
	confirmed, extra := agree(first, second)
	if !reflect.DeepEqual(confirmed, []bool{true, false, false, false, true}) || extra != 3 {
		t.Fatalf("got %v, extra %d", confirmed, extra)
	}
}

type fakeSecond struct {
	res    detector.Result
	err    error
	calls  int
	events *[]string
}

func (f *fakeSecond) Model() string { return "gpt-5" }
func (f *fakeSecond) Detect(_ context.Context, req detector.Request) (detector.Result, error) {
	f.calls++
	if f.events != nil {
		*f.events = append(*f.events, "second "+req.Key)
	}
	return f.res, f.err
}

var confirmCues = []vtt.Cue{{Start: 0, End: 10, Text: "a"}, {Start: 10, End: 40, Text: "b"}, {Start: 40, End: 60, Text: "c"}, {Start: 60, End: 90, Text: "d"}}

func segs(s ...detector.Segment) detector.Result {
	return detector.Result{Output: detector.Output{Segments: s}}
}
func seg(cat string, first, last int) detector.Segment {
	return detector.Segment{Category: cat, FirstCue: first, LastCue: last, Confidence: "high"}
}

func TestConfirmGatesOnlyWhenTheSecondModelAnswered(t *testing.T) {
	first := segs(seg("sponsor", 1, 1), seg("sponsor", 3, 3))
	f := &fakeSecond{res: segs(seg("sponsor", 1, 1))}
	r := &detectRun{second: f, secondPrice: detector.Prices["gpt-5"]}
	r.prompt.SHA = "sha"

	c := r.confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, first, nil)
	if c == nil || c.err != nil || !reflect.DeepEqual(c.gate(), []bool{true, false}) || c.extra != 0 || c.promptSHA != "sha" {
		t.Fatalf("answered: %+v", c)
	}

	f.res, f.err = detector.Result{}, errors.New("429 rate limited")
	if c = r.confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, first, nil); c == nil || c.err == nil || c.gate() != nil {
		t.Fatalf("API error: want no gate and the error kept, got %+v", c)
	}
	f.res, f.err = segs(seg("sponsor", 2, 9)), nil
	if c = r.confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, first, nil); c == nil || c.err == nil || c.gate() != nil {
		t.Fatalf("invalid answer: want no gate and the validation error kept, got %+v", c)
	}

	calls := f.calls
	if c = r.confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, first, errors.New("expired")); c != nil {
		t.Fatalf("failed first call: want nothing to confirm, got %+v", c)
	}
	if c = r.confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, segs(seg("sponsor", 5, 5)), nil); c != nil {
		t.Fatalf("invalid first answer: want nothing to confirm, got %+v", c)
	}
	if f.calls != calls {
		t.Fatal("a first answer with nothing to confirm must not call the second model")
	}
	if c = r.confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, segs(), nil); c == nil || len(c.gate()) != 0 || f.calls != calls+1 {
		t.Fatalf("empty first answer: the second call is still made (the measurement), got %+v", c)
	}
	if c = (&detectRun{}).confirm(context.Background(), "-1_456000001", transcript.Meta{}, confirmCues, first, nil); c != nil {
		t.Fatalf("switch off: got %+v", c)
	}
}

// lockSpy matches any argument and records when the query runs.
type lockSpy struct{ events *[]string }

func (l lockSpy) Match(driver.Value) bool { *l.events = append(*l.events, "lock"); return true }

type validFirst struct{ fakeBatch }

func (f *validFirst) Detect(_ context.Context, req detector.Request) (detector.Result, error) {
	return segs(seg("sponsor", 1, 1), seg("sponsor", 3, 3)), nil
}

// The second call happens before finish locks the queue row; its row and the
// unconfirmed entry's item are written in the publish transaction.
func TestPollConfirmsBeforeTheLockAndRecordsInThePublish(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	var events []string
	first := &validFirst{fakeBatch{ended: true}}
	second := &fakeSecond{res: segs(seg("sponsor", 1, 1), seg("self_promotion", 2, 2)), events: &events}
	r := &detectRun{db: db, client: first, batch: first, second: second, secondPrice: detector.Prices["gpt-5"],
		categories: map[string]int{"sponsor": 2, "self_promotion": 3}, prv: testPrv}
	r.cfg.MinSegmentSeconds = 5

	mock.ExpectQuery("WHERE v.status = 'detecting' AND v.batch_id IS NOT NULL").WillReturnRows(
		sqlmock.NewRows([]string{"native_id", "batch_id", "id", "video_id", "transcript"}).AddRow("-1_456000001", "msgbatch_1", 11, 7,
			[]byte(`{"meta":{},"cues":[{"start":0,"end":10,"text":"a"},{"start":10,"end":40,"text":"b"},{"start":40,"end":60,"text":"c"},{"start":60,"end":90,"text":"d"}]}`)))
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta("SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE")).WithArgs(lockSpy{&events}).
		WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("detecting"))
	mock.ExpectExec("UPDATE prv_ai_runs SET raw_output").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`(?s)DISTINCT ON .*FROM votes`).WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
	mock.ExpectExec("INSERT INTO prv_ai_video_calculateds").
		WithArgs(7, "-1_456000001", int64(11), []byte(`[{"category_id":2,"start":10,"end":40,"confidence":"high","source":"ai"}]`),
			[]byte(`[{"category_id":2,"start":60,"end":90,"confidence":"high","source":"ai","reason":"unconfirmed"}]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec("INSERT INTO prv_ai_confirmations").
		WithArgs(int64(11), 7, "-1_456000001", "gpt-5", "", nil, sqlmock.AnyArg(), 0.0, nil, 1, 1, 1).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WillReturnRows(sqlmock.NewRows([]string{"batch"}))
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_batches").WithArgs(sqlmock.AnyArg(), "important").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), "D1", 1, "-1_456000001", 60, 90, "sponsor", "d",
			"https://example.invalid/video-1_456000001?t=58s", []byte(`["second gpt-5: not found","entry: sponsor high, 30 s"]`), 7).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("UPDATE prv_ai_videos SET status = 'published'").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	if failed, err := r.poll(context.Background()); failed != 0 || err != nil {
		t.Fatalf("got %d %v", failed, err)
	}
	if !reflect.DeepEqual(events, []string{"second -1_456000001", "lock"}) {
		t.Fatalf("order: %v", events)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
