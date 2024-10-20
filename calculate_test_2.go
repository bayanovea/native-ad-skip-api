// package main

// import (
// 	"database/sql"
// 	"testing"

// 	"github.com/stretchr/testify/assert"
// 	"github.com/stretchr/testify/mock"
// )

// // Rows is our own interface that includes the methods we need from sql.Rows
// type Rows interface {
// 	Scan(dest ...interface{}) error
// 	Next() bool
// 	Err() error
// 	Close() error
// }

// type MockRows struct {
// 	mock.Mock
// }

// func (m *MockRows) Scan(dest ...interface{}) error {
// 	args := m.Called(dest...)
// 	return args.Error(0)
// }

// func (m *MockRows) Next() bool {
// 	args := m.Called()
// 	return args.Bool(0)
// }

// func (m *MockRows) Err() error {
// 	args := m.Called()
// 	return args.Error(0)
// }

// func (m *MockRows) Close() error {
// 	args := m.Called()
// 	return args.Error(0)
// }

// type MockDatabase struct {
// 	mock.Mock
// }

// // Change *sql.Rows to Rows in the return type
// func (m *MockDatabase) Query(query string, args ...interface{}) (Rows, error) {
// 	arguments := m.Called(query, args...)
// 	// Change *sql.Rows to *MockRows in the type assertion
// 	return arguments.Get(0).(*MockRows), arguments.Error(1)
// }

// func (m *MockDatabase) Exec(query string, args ...interface{}) (sql.Result, error) {
// 	arguments := m.Called(query, args...)
// 	return arguments.Get(0).(sql.Result), arguments.Error(1)
// }

// func TestCalculateIntervals(t *testing.T) {
// 	videoId := "666"

// 	getIntervalsSql := `
// 	  SELECT intervals.start, intervals.end, categories.id category_id, markups.id markup_id FROM markup_time_intervals intervals
// 		LEFT JOIN markups ON markups.id = intervals.markup_id
// 		LEFT JOIN markup_categories categories ON categories.id = markups.category_id
// 		WHERE markups.video_id = $1
// 		ORDER BY intervals.start
// 	`
// 	mockRows := new(MockRows)
// 	mockRows.On("Next").Return(false).Once()

// 	mockDB := new(MockDatabase)
// 	mockDB.On("Query", getIntervalsSql, []interface{}{videoId}).Return(mockRows, nil)

// 	intervals, markupIds := calculateIntervals(mockDB, videoId)

// 	assert.Equal(t, map[int]map[int]IntervalAggregated{}, intervals)
// 	assert.Equal(t, []int{}, markupIds)
// }

// package main

// import (
// 	"testing"

// 	"github.com/stretchr/testify/assert"
// 	"gopkg.in/DATA-DOG/go-sqlmock.v1"
// )

// func TestCalculateIntervals(t *testing.T) {
// 	videoId := "666"

// 	db, mock, err := sqlmock.New()
// 	if err != nil {
// 		t.Fatalf("an error '%s' was not expected when opening a stub database connection", err)
// 	}
// 	defer db.Close()

// 	getIntervalsSql := `
//   	SELECT intervals.start, intervals.end, categories.id category_id, markups.id markup_id FROM markup_time_intervals intervals
// 		LEFT JOIN markups ON markups.id = intervals.markup_id
// 		LEFT JOIN markup_categories categories ON categories.id = markups.category_id
// 		WHERE markups.video_id = $1
// 		ORDER BY intervals.start
// 	`

// 	mock.ExpectQuery(getIntervalsSql).
// 		WithArgs(videoId).
// 		WillReturnRows(sqlmock.NewRows([]string{"start", "end", "category_id", "markup_id"}))

// 	intervals, markupIds := calculateIntervals(db, videoId)

// 	assert.Equal(t, map[int]map[int]IntervalAggregated{}, intervals)
// 	assert.Equal(t, []int{}, markupIds)
// }
