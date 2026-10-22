package judge

import (
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

var reviewNow = time.Date(2026, 10, 21, 23, 30, 0, 0, time.UTC)

func TestAddReviewItemsSkipsAVideoWithAnOpenItem(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectBegin()
	mock.ExpectQuery(regexp.QuoteMeta(`i.kind = 'ai' AND i.video_id = $1`)).WithArgs(7).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	tx, _ := db.Begin()
	batch, err := addReviewItems(tx, testVideo, judgement{Decision: "review", By: "llm", Reason: "r"}, Signals{}, nil, testCategories, reviewNow)
	if err != nil || batch != "" {
		t.Fatalf("got %q %v", batch, err)
	}
}

func TestAddReviewItemsAppendsToAnUntouchedPartWithRoom(t *testing.T) {
	db, mock := newMock(t)
	v := testVideo
	v.Entries = append(v.Entries, Entry{CategoryID: 3, Start: 200, End: 230})
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT EXISTS").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectQuery(`(?s)SELECT b.batch FROM prv_review_batches b.*b.locked_by IS NULL.*\+ \$2 <= \$3.*NOT EXISTS.*FOR UPDATE OF b`).
		WithArgs("ai-judge-2026-10-21", 2, 30).WillReturnRows(sqlmock.NewRows([]string{"batch"}).AddRow("ai-judge-2026-10-21-p2"))
	mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(31))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-judge-2026-10-21", "ai-judge-2026-10-21-p2", "A32", 32, "-1_456000001", 30, 70, "sponsor", nil,
			"https://example.invalid/video-1_456000001?t=28s", sqlmock.AnyArg(), 7).WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec("INSERT INTO prv_review_items").
		WithArgs("ai-judge-2026-10-21", "ai-judge-2026-10-21-p2", "A33", 33, "-1_456000001", 200, 230, "self_promotion", nil,
			"https://example.invalid/video-1_456000001?t=3m18s", sqlmock.AnyArg(), 7).WillReturnResult(sqlmock.NewResult(1, 1))
	tx, _ := db.Begin()
	batch, err := addReviewItems(tx, v, judgement{Decision: "review", By: "llm", Reason: "r"}, Signals{}, nil, testCategories, reviewNow)
	if err != nil || batch != "ai-judge-2026-10-21-p2" {
		t.Fatalf("got %q %v", batch, err)
	}
}

func TestReviewBatchOpensTheNextPart(t *testing.T) {
	db, mock := newMock(t)
	mock.ExpectBegin()
	mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WillReturnRows(sqlmock.NewRows([]string{"batch"}))
	mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(2))
	mock.ExpectExec("INSERT INTO prv_review_batches").WithArgs("ai-judge-2026-10-21-p3").WillReturnResult(sqlmock.NewResult(0, 1))
	tx, _ := db.Begin()
	if batch, err := reviewBatch(tx, "ai-judge-2026-10-21", 1); err != nil || batch != "ai-judge-2026-10-21-p3" {
		t.Fatalf("got %q %v", batch, err)
	}
}
