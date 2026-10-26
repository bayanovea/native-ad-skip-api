package pipeline

import (
	"errors"
	"reflect"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/judge"
)

var regateCats = map[string]int{"sponsor": 2, "self_promotion": 3}

func pins(bounds ...[2]int) map[judge.EntryKey]time.Time {
	m := map[judge.EntryKey]time.Time{}
	for _, b := range bounds {
		m[judge.EntryKey{Start: b[0], End: b[1]}] = time.Time{}
	}
	return m
}

func TestPlaceThresholdRiseHidesAServedEntryWithoutItsRating(t *testing.T) {
	served, hid, in, moved := place([]Entry{re(2, 30, 70, "high", "ai", "", 2), re(2, 100, 150, "high", "ai", "", 0)}, []Entry{}, nil, regateCats, 41)
	if !reflect.DeepEqual(served, []Entry{re(2, 100, 150, "high", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []Entry{re(2, 30, 70, "high", "ai", "short", 0)}) || in != 0 || !moved {
		t.Fatalf("got %+v / %+v in %d moved %v", served, hid, in, moved)
	}
}

func TestPlaceThresholdDropServesAShortEntry(t *testing.T) {
	served, hid, in, moved := place([]Entry{re(2, 30, 70, "high", "ai", "", 2)},
		[]Entry{re(3, 300, 320, "medium", "ai", "confidence", 0), re(2, 480, 483, "high", "ai", "short", 0)}, nil, regateCats, 3)
	if !reflect.DeepEqual(served, []Entry{re(2, 30, 70, "high", "ai", "", 2), re(2, 480, 483, "high", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []Entry{re(3, 300, 320, "medium", "ai", "confidence", 0)}) || in != 1 || !moved {
		t.Fatalf("got %+v / %+v in %d moved %v", served, hid, in, moved)
	}
}

// A keep verdict pins an entry in the truth layer: the confidence rule never hides it, but
// the length rule still does.
func TestPlacePinnedEntriesSkipTheConfidenceRuleNotTheLengthRule(t *testing.T) {
	pinned := pins([2]int{30, 70}, [2]int{100, 130}, [2]int{400, 402})
	data := []Entry{re(2, 30, 70, "low", "review", "", 1), re(2, 200, 230, "low", "ai", "", 0)}
	hidden := []Entry{re(3, 100, 130, "medium", "ai", "confidence", 0), re(2, 400, 402, "low", "ai", "confidence", 0)}
	served, hid, in, moved := place(data, hidden, pinned, regateCats, 5)
	if !reflect.DeepEqual(served, []Entry{re(2, 30, 70, "low", "review", "", 1), re(3, 100, 130, "medium", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []Entry{re(2, 200, 230, "low", "ai", "confidence", 0), re(2, 400, 402, "low", "ai", "short", 0)}) ||
		in != 1 || !moved {
		t.Fatalf("got %+v / %+v in %d moved %v", served, hid, in, moved)
	}
}

// Not an ad on review is the last word: no rule, pin or threshold serves it again.
func TestPlaceNeverMovesAReviewEntry(t *testing.T) {
	hidden := []Entry{re(2, 30, 70, "high", "ai", "review", 0)}
	served, hid, in, moved := place([]Entry{}, hidden, pins([2]int{30, 70}), regateCats, 1)
	if len(served) != 0 || !reflect.DeepEqual(hid, hidden) || in != 0 || moved {
		t.Fatalf("got %+v / %+v in %d moved %v", served, hid, in, moved)
	}
}

// Served entries never overlap: a hidden entry the rules would serve stays hidden while it
// overlaps a served one (a keep verdict moved an entry over it), also one entering in the same pass.
func TestPlaceKeepsAHiddenEntryOverlappingAServedOneHidden(t *testing.T) {
	data := []Entry{re(2, 30, 75, "high", "review", "", 0)}
	hidden := []Entry{re(2, 70, 90, "high", "ai", "short", 0), re(2, 100, 104, "high", "ai", "short", 0), re(2, 103, 110, "high", "ai", "short", 0)}
	served, hid, in, moved := place(data, hidden, nil, regateCats, 3)
	if !reflect.DeepEqual(served, []Entry{re(2, 30, 75, "high", "review", "", 0), re(2, 100, 104, "high", "ai", "", 0)}) ||
		!reflect.DeepEqual(hid, []Entry{re(2, 70, 90, "high", "ai", "short", 0), re(2, 103, 110, "high", "ai", "short", 0)}) || in != 1 || !moved {
		t.Fatalf("got %+v / %+v in %d moved %v", served, hid, in, moved)
	}
}

func TestPlaceNothingToMove(t *testing.T) {
	_, _, _, moved := place([]Entry{re(2, 30, 70, "high", "ai", "", 2)}, []Entry{re(2, 480, 483, "high", "ai", "short", 0)}, nil, regateCats, 5)
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

	changed, err := regateRow(db, regateCats, 3, 7, false)
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

	changed, err := regateRow(db, regateCats, 5, 7, true)
	if err != nil || !changed {
		t.Fatalf("got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// A prediction a keep verdict re-categorised or moved overlaps its served entry and is not
// added again, so a second backfill of a row whose hidden the verdicts emptied adds nothing.
func TestRegateRowBackfillSkipsAPredictionOverlappingAServedEntry(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	expectRegateLock(mock, `[{"category_id":3,"start":302,"end":318,"confidence":"medium","source":"review"}]`, `[]`, 3)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT raw_output, transcript FROM prv_ai_runs")).WithArgs(int64(3)).
		WillReturnRows(sqlmock.NewRows([]string{"raw_output", "transcript"}).AddRow(
			[]byte(`{"segments":[{"category":"self_promotion","first_cue":2,"last_cue":2,"confidence":"medium","quote":"подписывайтесь"}]}`),
			[]byte(backfillTranscript)))
	mock.ExpectQuery(regexp.QuoteMeta(`WHERE k.verdict IN ('sponsor', 'self_promotion') AND k.decided_at > $3`)).
		WithArgs(7, sqlmock.AnyArg(), time.Time{}).WillReturnRows(sqlmock.NewRows([]string{"start", "end", "decided_at"}).AddRow(302, 318, time.Now()))
	mock.ExpectRollback()
	if changed, err := regateRow(db, regateCats, 5, 7, true); err != nil || changed {
		t.Fatalf("got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// A stored answer that no longer validates against its transcript is skipped, not a failed row
// (it would fail every later run).
func TestRegateRowBackfillSkipsARunThatNoLongerValidates(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	expectRegateLock(mock, `[]`, `[]`, 3)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT raw_output, transcript FROM prv_ai_runs")).WithArgs(int64(3)).
		WillReturnRows(sqlmock.NewRows([]string{"raw_output", "transcript"}).AddRow(
			[]byte(`{"segments":[{"category":"sponsor","first_cue":9,"last_cue":9,"confidence":"low","quote":"x"}]}`), []byte(backfillTranscript)))
	expectNoKeeps(mock)
	mock.ExpectRollback()
	if changed, err := regateRow(db, regateCats, 5, 7, true); err != nil || changed {
		t.Fatalf("got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

// A failing row is logged and counted; the others still run and the command fails at the end.
func TestRegateCountsAFailedRow(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT id, category FROM markup_categories").
		WillReturnRows(sqlmock.NewRows([]string{"id", "category"}).AddRow(2, "sponsor").AddRow(3, "self_promotion"))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT video_id FROM prv_ai_video_calculateds ORDER BY video_id")).
		WillReturnRows(sqlmock.NewRows([]string{"video_id"}).AddRow(6).AddRow(7))
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(6).WillReturnError(errors.New("boom"))
	mock.ExpectRollback()
	expectRegateLock(mock, `[]`, `[]`, nil)
	expectNoKeeps(mock)
	mock.ExpectRollback()
	if err := regate(db, 5, false); err == nil || err.Error() != "1 of 2 rows failed" {
		t.Fatalf("got %v", err)
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
	expectRegateLock(mock, `[]`, `[{"category_id":2,"start":20,"end":30,"confidence":"low","source":"ai","reason":"confidence"}]`, 3)
	expectNoKeeps(mock)
	mock.ExpectRollback()
	if changed, err := regateRow(db, regateCats, 5, 7, true); err != nil || changed {
		t.Fatalf("filled hidden: got %v %v", changed, err)
	}

	expectRegateLock(mock, `[]`, `[]`, 3)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT raw_output, transcript FROM prv_ai_runs")).WithArgs(int64(3)).
		WillReturnRows(sqlmock.NewRows([]string{"raw_output", "transcript"}))
	expectNoKeeps(mock)
	mock.ExpectRollback()
	if changed, err := regateRow(db, regateCats, 5, 7, true); err != nil || changed {
		t.Fatalf("no raw_output: got %v %v", changed, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
