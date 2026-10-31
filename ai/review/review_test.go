package review

import (
	"database/sql"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/vtt"
)

func begin(t *testing.T) (*sql.Tx, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	mock.ExpectBegin()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	return tx, mock
}

func TestBatchOpensTheNextPartWithItsPriority(t *testing.T) {
	tx, mock := begin(t)
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WithArgs("ai-second-2026-10-30", 1, BatchMax).WillReturnRows(sqlmock.NewRows([]string{"batch"}))
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(2))
	mock.ExpectExec(`INSERT INTO prv_review_batches \(batch, priority\) VALUES \(\$1, \$2\)`).WithArgs("ai-second-2026-10-30-p3", "important").
		WillReturnResult(sqlmock.NewResult(0, 1))
	if batch, err := Batch(tx, "ai-second-2026-10-30", 1, "important"); err != nil || batch != "ai-second-2026-10-30-p3" {
		t.Fatalf("got %q %v", batch, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestAddNumbersItemsAfterTheSheet(t *testing.T) {
	tx, mock := begin(t)
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WillReturnRows(sqlmock.NewRows([]string{"batch"}))
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_batches").WithArgs("s", "urgent").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("s", "s", "D1", 1, "-1_456000001", 30, 70, "sponsor", "a\nb", "link", []byte(`["x"]`), 7).WillReturnResult(sqlmock.NewResult(1, 1))
	cues := []vtt.Cue{{Start: 20, End: 31, Text: "a"}, {Start: 60, End: 65, Text: "b"}, {Start: 70, End: 80, Text: "c"}}
	items := []Item{{NativeID: "-1_456000001", VideoID: 7, Start: 30, End: 70, Proposed: "sponsor", Cues: CueText(cues, 30, 70, "\n"), Link: "link", FlaggedBy: []string{"x"}}}
	if batch, err := Add(tx, "s", "D", "urgent", items); err != nil || batch != "s" {
		t.Fatalf("got %q %v", batch, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
