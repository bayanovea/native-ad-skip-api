package pipeline

import (
	"reflect"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

var regateNames = map[int]string{2: "sponsor", 3: "self_promotion"}

func re(cat, start, end int, conf, source, reason string, rating int) rowEntry {
	return rowEntry{Entry{cat, start, end, conf, source, reason}, rating}
}

func TestPlaceThresholdRiseHidesAServedEntryWithoutItsRating(t *testing.T) {
	served, hid, in, out, moved := place([]rowEntry{re(2, 30, 70, "high", "ai", "", 2), re(2, 100, 150, "high", "ai", "", 0)}, []rowEntry{}, nil, regateNames, 41)
	if !reflect.DeepEqual(served, []rowEntry{re(2, 100, 150, "high", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []rowEntry{re(2, 30, 70, "high", "ai", "short", 0)}) || in != 0 || out != 1 || !moved {
		t.Fatalf("got %+v / %+v in %d out %d moved %v", served, hid, in, out, moved)
	}
}

func TestPlaceThresholdDropServesAShortEntry(t *testing.T) {
	served, hid, in, out, moved := place([]rowEntry{re(2, 30, 70, "high", "ai", "", 2)},
		[]rowEntry{re(3, 300, 320, "medium", "ai", "confidence", 0), re(2, 480, 483, "high", "ai", "short", 0)}, nil, regateNames, 3)
	if !reflect.DeepEqual(served, []rowEntry{re(2, 30, 70, "high", "ai", "", 2), re(2, 480, 483, "high", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []rowEntry{re(3, 300, 320, "medium", "ai", "confidence", 0)}) || in != 1 || out != 0 || !moved {
		t.Fatalf("got %+v / %+v in %d out %d moved %v", served, hid, in, out, moved)
	}
}

// A keep verdict pins an entry in the truth layer: the confidence rule never hides it, but
// the length rule still does.
func TestPlacePinnedEntriesSkipTheConfidenceRuleNotTheLengthRule(t *testing.T) {
	pinned := map[[2]int]bool{{30, 70}: true, {100, 130}: true, {400, 402}: true}
	data := []rowEntry{re(2, 30, 70, "low", "review", "", 1), re(2, 200, 230, "low", "ai", "", 0)}
	hidden := []rowEntry{re(3, 100, 130, "medium", "ai", "confidence", 0), re(2, 400, 402, "low", "ai", "confidence", 0)}
	served, hid, in, out, moved := place(data, hidden, pinned, regateNames, 5)
	if !reflect.DeepEqual(served, []rowEntry{re(2, 30, 70, "low", "review", "", 1), re(3, 100, 130, "medium", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []rowEntry{re(2, 200, 230, "low", "ai", "confidence", 0), re(2, 400, 402, "low", "ai", "short", 0)}) ||
		in != 1 || out != 1 || !moved {
		t.Fatalf("got %+v / %+v in %d out %d moved %v", served, hid, in, out, moved)
	}
}

// Not an ad on review is the last word: no rule, pin or threshold serves it again.
func TestPlaceNeverMovesAReviewEntry(t *testing.T) {
	hidden := []rowEntry{re(2, 30, 70, "high", "ai", "review", 0)}
	served, hid, in, out, moved := place([]rowEntry{}, hidden, map[[2]int]bool{{30, 70}: true}, regateNames, 1)
	if len(served) != 0 || !reflect.DeepEqual(hid, hidden) || in+out != 0 || moved {
		t.Fatalf("got %+v / %+v in %d out %d moved %v", served, hid, in, out, moved)
	}
}

func TestPlaceNothingToMove(t *testing.T) {
	_, _, _, _, moved := place([]rowEntry{re(2, 30, 70, "high", "ai", "", 2)}, []rowEntry{re(2, 480, 483, "high", "ai", "short", 0)}, nil, regateNames, 5)
	if moved {
		t.Fatal("unchanged row reported as moved")
	}
}

func expectRegateLock(mock sqlmock.Sqlmock, data, hidden string, runID any) {
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT data, hidden, run_id FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"data", "hidden", "run_id"}).AddRow([]byte(data), []byte(hidden), runID))
}

// Pinned = a keep verdict whenever decided: the judge's keep query with no lower bound.
func expectNoKeeps(mock sqlmock.Sqlmock) {
	mock.ExpectQuery(regexp.QuoteMeta(`WHERE k.verdict IN ('sponsor', 'self_promotion') AND k.decided_at > $3`)).
		WithArgs(7, sqlmock.AnyArg(), time.Time{}).WillReturnRows(sqlmock.NewRows([]string{"start", "end", "decided_at"}))
}

func TestRegateRowServesAShortEntryWithTheVotesRatingWhenTheThresholdDrops(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	expectRegateLock(mock, `[{"category_id":2,"start":30,"end":70,"confidence":"high","source":"ai","rating":2}]`,
		`[{"category_id":2,"start":480,"end":483,"confidence":"high","source":"ai","reason":"short"}]`, 3)
	expectNoKeeps(mock)
	mock.ExpectQuery(`(?s)DISTINCT ON \(user_id, category_id, start, "end"\).*FROM votes`).WithArgs("7").
		WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}).AddRow(2, 30.0, 70.0, 2).AddRow(2, 480.0, 483.0, 1))
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3")).
		WithArgs(7, []byte(`[{"category_id":2,"confidence":"high","end":70,"rating":2,"source":"ai","start":30},{"category_id":2,"confidence":"high","end":483,"rating":1,"source":"ai","start":480}]`), []byte(`[]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	changed, err := regateRow(db, map[string]int{"sponsor": 2, "self_promotion": 3}, 3, 7, false)
	if err != nil || !changed {
		t.Fatalf("got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

const backfillTranscript = `{"meta":{},"cues":[{"start":0,"end":10,"text":"привет"},{"start":30,"end":70,"text":"спонсор"},{"start":300,"end":320,"text":"подписывайтесь"},{"start":480,"end":490,"text":"промокод"}]}`

// The served sponsor is already in data and the not-an-ad entry a verdict removed passed
// the rules (not resurrected); the self-promotion at medium comes back hidden.
func TestRegateRowBackfillsAnEmptyHiddenFromTheRun(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	expectRegateLock(mock, `[{"category_id":2,"start":30,"end":70,"confidence":"high","source":"ai","rating":2}]`, `[]`, 3)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT raw_output, transcript FROM prv_ai_runs")).WithArgs(int64(3)).
		WillReturnRows(sqlmock.NewRows([]string{"raw_output", "transcript"}).AddRow(
			[]byte(`{"segments":[{"category":"sponsor","first_cue":1,"last_cue":1,"confidence":"high","quote":"спонсор"},{"category":"self_promotion","first_cue":2,"last_cue":2,"confidence":"medium","quote":"подписывайтесь"},{"category":"sponsor","first_cue":3,"last_cue":3,"confidence":"high","quote":"промокод"}]}`),
			[]byte(backfillTranscript)))
	expectNoKeeps(mock)
	mock.ExpectExec(regexp.QuoteMeta("UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3")).
		WithArgs(7, []byte(`[{"category_id":2,"start":30,"end":70,"confidence":"high","source":"ai","rating":2}]`),
			[]byte(`[{"category_id":3,"start":300,"end":320,"confidence":"medium","source":"ai","reason":"confidence"}]`)).
		WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectCommit()

	changed, err := regateRow(db, map[string]int{"sponsor": 2, "self_promotion": 3}, 5, 7, true)
	if err != nil || !changed {
		t.Fatalf("got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// A row with a hidden list is never backfilled (no run read); a run without an object
// raw_output gives nothing to fill; neither row is written.
func TestRegateRowBackfillSkipsAFilledHiddenAndARunWithoutOutput(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cats := map[string]int{"sponsor": 2, "self_promotion": 3}

	expectRegateLock(mock, `[]`, `[{"category_id":2,"start":20,"end":30,"confidence":"low","source":"ai","reason":"confidence"}]`, 3)
	expectNoKeeps(mock)
	mock.ExpectRollback()
	if changed, err := regateRow(db, cats, 5, 7, true); err != nil || changed {
		t.Fatalf("filled hidden: got %v %v", changed, err)
	}

	expectRegateLock(mock, `[]`, `[]`, 3)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT raw_output, transcript FROM prv_ai_runs")).WithArgs(int64(3)).
		WillReturnRows(sqlmock.NewRows([]string{"raw_output", "transcript"}))
	expectNoKeeps(mock)
	mock.ExpectRollback()
	if changed, err := regateRow(db, cats, 5, 7, true); err != nil || changed {
		t.Fatalf("no raw_output: got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
