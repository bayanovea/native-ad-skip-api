package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"

	_ "github.com/lib/pq"
)

type Interval struct {
	start int
	end   int
}

type IntervalAggregated struct {
	startAverage int
	endAverage   int
	intervals    []Interval
}

func main() {
	db := connectDb()
	defer db.Close()

	args := os.Args[1:]

	if len(args) == 0 {
		panic("Please provide videoId")
	}
	videoId := args[0]

	// Clear video_calculated table by current video
	deleteOldCalculationsSql := `
		DELETE FROM video_calculateds
		WHERE video_id = $1
	`

	_, err := db.Query(deleteOldCalculationsSql, videoId)
	if err != nil {
		panic(err)
	}

	// Calculate intervals
	getIntervalsSql := `
  SELECT intervals.start, intervals.end, categories.id category_id FROM markup_time_intervals intervals
    LEFT JOIN markups ON markups.id = intervals.markup_id
    LEFT JOIN markup_categories categories ON categories.id = markups.category_id
    WHERE markups.video_id = $1
    ORDER BY intervals.start
  `

	videos, err := db.Query(getIntervalsSql, videoId)
	if err != nil {
		panic(err)
	}
	defer videos.Close()

	intervals := make(map[int]map[int]IntervalAggregated)

	for videos.Next() {
		var start int
		var end int
		var categoryId int

		err := videos.Scan(&start, &end, &categoryId)
		if err != nil {
			panic(err)
		}

		startRounded := start - (start % 3)

		if _, ok := intervals[categoryId]; !ok {
			intervals[categoryId] = make(map[int]IntervalAggregated)
		}

		if _, ok := intervals[categoryId][startRounded]; !ok {
			intervals[categoryId][startRounded] = IntervalAggregated{}
		}

		aggregated := intervals[categoryId][startRounded]
		aggregated.intervals = append(aggregated.intervals, Interval{start, end})
		intervals[categoryId][startRounded] = aggregated
	}

	for categoryId, level1 := range intervals {
		for startRounded, level2 := range level1 {

			startSum := 0
			endNumbers := make([]int, 0, len(level2.intervals))

			for _, interval := range level2.intervals {
				startSum += interval.start
				endNumbers = append(endNumbers, interval.end)
			}

			startAverage := startSum / len(level2.intervals)
			endAverage := findMedian(endNumbers)

			aggregated := intervals[categoryId][startRounded]
			aggregated.startAverage = startAverage
			aggregated.endAverage = endAverage
			intervals[categoryId][startRounded] = aggregated
		}
	}

	// Insert video_calculated to DB
	for categoryId, level1 := range intervals {
		for _, level2 := range level1 {
			data := map[string]interface{}{
				"category_id": categoryId,
				"start":       level2.startAverage,
				"end":         level2.endAverage,
			}

			jsonData, err := json.Marshal(data)
			if err != nil {
				log.Fatalf("Ошибка при преобразовании в JSON: %v", err)
			}

			insertVideoCalculatedSql := `
				INSERT INTO video_calculateds (video_id, data, "createdAt", "updatedAt")
				VALUES ($1, $2, now(), now())
	  		`

			insert, err := db.Query(insertVideoCalculatedSql, videoId, jsonData)
			if err != nil {
				panic(err)
			}
			defer insert.Close()
		}
	}
}

func connectDb() *sql.DB {
	psqlInfo := fmt.Sprintf("host=%s port=%d user=%s "+
		"password=%s dbname=%s sslmode=disable",
		"localhost", 5432, "postgres", "", "postgres")

	db, err := sql.Open("postgres", psqlInfo)
	if err != nil {
		panic(err)
	}

	err = db.Ping()
	if err != nil {
		panic(err)
	}

	return db
}

func findMedian(nums []int) int {
	l := len(nums)

	if l == 0 {
		return 0
	}

	sort.Ints(nums)

	return nums[int(l/2)]
}
