package pipeline

import (
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/detector"
)

func re(cat, start, end int, conf, source, reason string, rating int) Entry {
	return Entry{cat, start, end, conf, source, reason, rating}
}

func pred(cat, conf string, start, end float64) detector.Prediction {
	return detector.Prediction{Segment: detector.Segment{Category: cat, Confidence: conf}, Start: start, End: end}
}

func TestEntriesSplitsServedAndHidden(t *testing.T) {
	cats := map[string]int{"sponsor": 2, "self_promotion": 3}
	served, hidden := entries([]detector.Prediction{
		pred("sponsor", "high", 10.2, 40.8),        // served, shrunk to whole seconds
		pred("sponsor", "medium", 50, 60),          // served
		pred("sponsor", "low", 70, 90),             // low: confidence
		pred("self_promotion", "high", 100, 130),   // served
		pred("self_promotion", "medium", 140, 170), // self-promotion needs high
		pred("sponsor", "high", 200.5, 205.4),      // 201..205 is 4 s: short
		pred("sponsor", "high", 300, 305),          // exactly 5 s: served
		pred("sponsor", "low", 400, 402),           // both: confidence first (the truth layer before the serving filter)
	}, cats, 5)
	wantServed := []Entry{
		re(2, 11, 40, "high", "ai", "", 0),
		re(2, 50, 60, "medium", "ai", "", 0),
		re(3, 100, 130, "high", "ai", "", 0),
		re(2, 300, 305, "high", "ai", "", 0),
	}
	wantHidden := []Entry{
		re(2, 70, 90, "low", "ai", "confidence", 0),
		re(3, 140, 170, "medium", "ai", "confidence", 0),
		re(2, 201, 205, "high", "ai", "short", 0),
		re(2, 400, 402, "low", "ai", "confidence", 0),
	}
	if !reflect.DeepEqual(served, wantServed) || !reflect.DeepEqual(hidden, wantHidden) {
		t.Fatalf("got %+v / %+v\nwant %+v / %+v", served, hidden, wantServed, wantHidden)
	}

	served, hidden = entries([]detector.Prediction{pred("sponsor", "high", 200.5, 205.4), pred("sponsor", "high", 300, 305)}, cats, 3)
	if !reflect.DeepEqual(served, []Entry{re(2, 201, 205, "high", "ai", "", 0), re(2, 300, 305, "high", "ai", "", 0)}) || len(hidden) != 0 {
		t.Fatalf("threshold 3: got %+v / %+v", served, hidden)
	}
	served, hidden = entries([]detector.Prediction{pred("sponsor", "high", 300, 305)}, cats, 6)
	if len(served) != 0 || !reflect.DeepEqual(hidden, []Entry{re(2, 300, 305, "high", "ai", "short", 0)}) {
		t.Fatalf("threshold 6: got %+v / %+v", served, hidden)
	}

	served, hidden = entries([]detector.Prediction{pred("sponsor", "low", 10.2, 10.9), pred("sponsor", "high", 20.5, 21.4)}, cats, 1)
	if len(served) != 0 || len(hidden) != 0 {
		t.Fatalf("no whole second inside: want nothing stored, got %+v / %+v", served, hidden)
	}

	served, hidden = entries(nil, cats, 5)
	if served == nil || len(served) != 0 || hidden == nil || len(hidden) != 0 {
		t.Fatalf("no predictions: want empty, non-nil lists (published as []), got %#v / %#v", served, hidden)
	}
}

func TestLoadCategories(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery("SELECT id, category FROM markup_categories").
		WillReturnRows(sqlmock.NewRows([]string{"id", "category"}).AddRow(1, "intro").AddRow(2, "sponsor").AddRow(3, "self_promotion"))
	m, err := loadCategories(db)
	if err != nil || m["sponsor"] != 2 || m["self_promotion"] != 3 {
		t.Fatalf("got %v, %v", m, err)
	}

	mock.ExpectQuery("SELECT id, category FROM markup_categories").
		WillReturnRows(sqlmock.NewRows([]string{"id", "category"}).AddRow(1, "intro").AddRow(2, "sponsor"))
	if _, err := loadCategories(db); err == nil || !strings.Contains(err.Error(), "self_promotion") {
		t.Fatalf("missing category: want an error naming it, got %v", err)
	}
}

func TestRawJSON(t *testing.T) {
	if rawJSON("") != nil {
		t.Fatal("no answer: want NULL")
	}
	if got := rawJSON(`{"segments":[]}`); got != `{"segments":[]}` {
		t.Fatalf("JSON kept as is, got %v", got)
	}
	if got := rawJSON("cut off {"); got != `"cut off {"` {
		t.Fatalf("text stored as a JSON string, got %v", got)
	}
}

func TestPublishRatesTheEntriesFromTheVotesUnderTheVideoCalculatedLock(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectBegin()
	// A recalculation replaced the row while the lock waited: read once more.
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`(?s)DISTINCT ON \(user_id, category_id, start, "end"\).*FROM votes`).WithArgs("7").
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}).AddRow(2, 11.0, 40.0, -2).AddRow(2, 50.0, 60.0, 0))
	// Hidden entries go as they are: no ratings, nothing there reaches a player.
	mock.ExpectExec("INSERT INTO prv_ai_video_calculateds").
		WithArgs(7, "-1_456000001", int64(3), []byte(`[{"category_id":2,"confidence":"high","end":40,"rating":-2,"source":"ai","start":11},{"category_id":2,"confidence":"medium","end":60,"source":"ai","start":50}]`),
			[]byte(`[{"category_id":2,"start":70,"end":90,"confidence":"low","source":"ai","reason":"confidence"}]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := publish(tx, 7, "-1_456000001", 3, []Entry{re(2, 11, 40, "high", "ai", "", 0), re(2, 50, 60, "medium", "ai", "", 0)},
		[]Entry{re(2, 70, 90, "low", "ai", "confidence", 0)}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
