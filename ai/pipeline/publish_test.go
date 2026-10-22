package pipeline

import (
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/detector"
)

func pred(cat, conf string, start, end float64) detector.Prediction {
	return detector.Prediction{Segment: detector.Segment{Category: cat, Confidence: conf}, Start: start, End: end}
}

func TestEntriesThresholds(t *testing.T) {
	cats := map[string]int{"sponsor": 2, "self_promotion": 3}
	got := entries([]detector.Prediction{
		pred("sponsor", "high", 10.2, 40.8),        // kept, shrunk to whole seconds
		pred("sponsor", "medium", 50, 60),          // kept
		pred("sponsor", "low", 70, 90),             // low: dropped
		pred("self_promotion", "high", 100, 130),   // kept
		pred("self_promotion", "medium", 140, 170), // self-promotion needs high
		pred("sponsor", "high", 200.5, 205.4),      // 201..205 is 4 s: dropped
		pred("sponsor", "high", 300, 305),          // exactly 5 s: kept
	}, cats)
	want := []Entry{
		{2, 11, 40, "high", "ai"},
		{2, 50, 60, "medium", "ai"},
		{3, 100, 130, "high", "ai"},
		{2, 300, 305, "high", "ai"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
	if got := entries(nil, cats); got == nil || len(got) != 0 {
		t.Fatalf("no predictions: want an empty, non-nil list (published as []), got %#v", got)
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
	mock.ExpectExec("INSERT INTO prv_ai_video_calculateds").
		WithArgs(7, "-1_456000001", int64(3), []byte(`[{"category_id":2,"confidence":"high","end":40,"rating":-2,"source":"ai","start":11},{"category_id":2,"confidence":"medium","end":60,"source":"ai","start":50}]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := publish(tx, 7, "-1_456000001", 3, []Entry{{2, 11, 40, "high", "ai"}, {2, 50, 60, "medium", "ai"}}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
