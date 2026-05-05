package calculator

import (
	"fmt"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

type TestCase struct {
	Key  string
	Nums []int
	Res  int
}

func TestFindMedian(t *testing.T) {
	cases := []TestCase{
		{"empty", []int{}, 0},
		{"single", []int{7}, 7},
		{"even", []int{1, 20, 22}, 20},
		{"odd", []int{1, 20, 22, 40}, 22},
		{"with_negative", []int{-30, -20, -10, 0, 10}, -10},
	}

	for caseNum, item := range cases {
		res := FindMedian(item.Nums)

		if item.Res != res {
			t.Errorf("[%d] test case %s failed: got %d, expected %d",
				caseNum, item.Key, res, item.Res)
		}
	}
}

func TestCalculateIntervals(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("error creating mock DB: %v", err)
	}
	defer db.Close()

	rows := sqlmock.NewRows([]string{"start", "end", "category_id", "markup_id"}).
		AddRow(0, 1, 1, 1).
		AddRow(0, 3, 1, 2).
		AddRow(0, 2, 1, 3)

	mock.ExpectQuery(regexp.QuoteMeta("markup_time_intervals")).
		WithArgs("111_222").
		WillReturnRows(rows)

	intervals := CalculateIntervals(db, "111_222", "")

	fmt.Println("Intervals:", intervals)

	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("there were unfulfilled expectations: %s", err)
	}

	if intervals[1][0].startAverage != 0 {
		t.Errorf("expected startAverage to be 0, got %d", intervals[1][0].startAverage)
	}
	if intervals[1][0].endAverage != 2 {
		t.Errorf("expected endAverage to be 2, got %d", intervals[1][0].endAverage)
	}
}
