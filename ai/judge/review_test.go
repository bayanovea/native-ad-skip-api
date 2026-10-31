package judge

import (
	"database/sql"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/provider"
)

var reviewNow = time.Date(2026, 10, 21, 23, 30, 0, 0, time.UTC)

// testPrv is prv with the e2e templates (docker-compose.e2e.yml); Register panics on a duplicate, so once per binary.
var testPrv = func() provider.Provider {
	provider.Register(provider.Def{Name: "prv", VideoURL: "https://example.invalid/video{id}", LinkAt: "https://example.invalid/video{id}?t={t}"})
	p, _ := provider.Lookup("prv")
	return p
}()

func begin(t *testing.T, db *sql.DB) *sql.Tx {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func TestAddReviewItemsSkipsEveryEntryWithAnOpenItem(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`i.kind = 'ai' AND i.video_id = $1`) + `(?s).*` + regexp.QuoteMeta(`NOT EXISTS (SELECT 1 FROM prv_review_verdicts r WHERE r.item_id = i.id)`)).
		WithArgs(7).WillReturnRows(sqlmock.NewRows([]string{"start", "end"}).AddRow(30, 70))
	mock.ExpectRollback()
	batch, n, err := addReviewItems(begin(t, db), testPrv, testVideo, judgement{Decision: "review", By: "llm", Reason: "r"}, Signals{}, nil, testCategories, reviewNow)
	if err != nil || batch != "" || n != 0 {
		t.Fatalf("got %q %d %v", batch, n, err)
	}
}

// An older item still open on one entry (its row withdrawn meanwhile) does not keep the other entries from a human.
func TestAddReviewItemsAddsTheEntriesWithoutAnOpenItem(t *testing.T) {
	db, mock := newMock(t)
	v := testVideo
	v.Entries = append(v.Entries, Entry{CategoryID: 3, Start: 200, End: 230})
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT i.start, i."end"`)).WithArgs(7).WillReturnRows(sqlmock.NewRows([]string{"start", "end"}).AddRow(30, 70))
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WithArgs("ai-judge-2026-10-21", 1, 30).
		WillReturnRows(sqlmock.NewRows([]string{"batch"}).AddRow("ai-judge-2026-10-21"))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(4))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-judge-2026-10-21", "ai-judge-2026-10-21", "A5", 5, "-1_456000001", 200, 230, "self_promotion", nil,
			"https://example.invalid/video-1_456000001?t=3m18s", sqlmock.AnyArg(), 7).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectRollback()
	batch, n, err := addReviewItems(begin(t, db), testPrv, v, judgement{Decision: "withdraw", By: "llm", Reason: "r"}, Signals{}, nil, testCategories, reviewNow)
	if err != nil || batch != "ai-judge-2026-10-21" || n != 1 {
		t.Fatalf("got %q %d %v", batch, n, err)
	}
}

func TestAddReviewItemsAppendsToAnUntouchedPartWithRoom(t *testing.T) {
	db, mock := newMock(t)
	v := testVideo
	v.Entries = append(v.Entries, Entry{CategoryID: 3, Start: 200, End: 230})
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT i.start, i."end"`)).WillReturnRows(sqlmock.NewRows([]string{"start", "end"}))
	mock.ExpectQuery(`(?s)SELECT b.batch FROM prv_review_batches b.*b.locked_by IS NULL.*\+ \$2 <= \$3.*NOT EXISTS.*FOR UPDATE OF b`).
		WithArgs("ai-judge-2026-10-21", 2, 30).WillReturnRows(sqlmock.NewRows([]string{"batch"}).AddRow("ai-judge-2026-10-21-p2"))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(31))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-judge-2026-10-21", "ai-judge-2026-10-21-p2", "A32", 32, "-1_456000001", 30, 70, "sponsor", nil,
			"https://example.invalid/video-1_456000001?t=28s", sqlmock.AnyArg(), 7).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-judge-2026-10-21", "ai-judge-2026-10-21-p2", "A33", 33, "-1_456000001", 200, 230, "self_promotion", nil,
			"https://example.invalid/video-1_456000001?t=3m18s", sqlmock.AnyArg(), 7).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectRollback()
	batch, n, err := addReviewItems(begin(t, db), testPrv, v, judgement{Decision: "review", By: "llm", Reason: "r"}, Signals{}, nil, testCategories, reviewNow)
	if err != nil || batch != "ai-judge-2026-10-21-p2" || n != 2 {
		t.Fatalf("got %q %d %v", batch, n, err)
	}
}
