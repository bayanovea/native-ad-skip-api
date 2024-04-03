package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"

	"github.com/joho/godotenv"
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
	markupIds    []int
}

func main() {
	db := connectDb()
	defer db.Close()

	videoIds := getVideoIds(db)
	pool := NewGoroutinePool(10)

	for _, videoId := range videoIds {
		id := videoId
		pool.Execute(func() {
			caclulateVideo(id, db)
		})
	}

	pool.Close()
}

/**
 * Get video ids from command line argument or if it is empty, get all video ids with new markups
 */
func getVideoIds(db *sql.DB) []string {
	args := os.Args[1:]

	if len(args) == 0 {
		return getVideoIdsWithNewMarkups(db)
	}

	return []string{args[0]}
}

func getVideoIdsWithNewMarkups(db *sql.DB) []string {
	getVideoIdsSql := `
		SELECT DISTINCT video_id FROM markups
		WHERE is_new = true
	`

	rows, err := db.Query(getVideoIdsSql)
	if err != nil {
		panic(err)
	}
	defer rows.Close()

	var videoIds []string
	for rows.Next() {
		var videoId string
		if err := rows.Scan(&videoId); err != nil {
			panic(err)
		}

		videoIds = append(videoIds, videoId)
	}

	return videoIds
}

func caclulateVideo(videoId string, db *sql.DB) {
	fmt.Println("Calculate video start: ", videoId)

	clearOldVideoCalculated(db, videoId)
	intervals, markupIds := calculateIntervals(db, videoId)
	insertVideoCalculated(db, videoId, intervals, markupIds)
	updateIsNew(db, videoId)

	fmt.Println("Calculate video finish: ", videoId)
}

func clearOldVideoCalculated(db *sql.DB, videoId string) {
	deleteOldCalculationsSql := `
		DELETE FROM video_calculateds
		WHERE video_id = $1
	`

	_, err := db.Query(deleteOldCalculationsSql, videoId)
	if err != nil {
		panic(err)
	}
}

/*
Calculate algorithm:
1. Get all intervals for video
2. Group intervals by category and startRounded value, where startRounded - every 3 seconds. For example: 0, 3, 6, ... 2 will be in 0, 4 will be in 3.
3. Calculate AVERAGE start and MEDIAN end values for each group. For half values, round down.

intervals format:

	{
		cayegoryId: {  // Represents the category identifier
			startRounded: {  // Represents the rounded start value
				startAverage,
				endAverage,
				[
					Interval1,
					Interval2,
					...
				]
			}
		},
		...
	}
*/
func calculateIntervals(db *sql.DB, videoId string) (map[int]map[int]IntervalAggregated, []int) {
	getIntervalsSql := `
  	SELECT intervals.start, intervals.end, categories.id category_id, markups.id markup_id FROM markup_time_intervals intervals
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

	markupIdsMap := make(map[int]bool)
	intervals := make(map[int]map[int]IntervalAggregated)

	// Group intervals by category and startRounded value
	for videos.Next() {
		var start, end, categoryId, markupId int

		err := videos.Scan(&start, &end, &categoryId, &markupId)
		if err != nil {
			panic(err)
		}

		if _, ok := markupIdsMap[markupId]; !ok {
			markupIdsMap[markupId] = true
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
		aggregated.markupIds = append(aggregated.markupIds, markupId)
		intervals[categoryId][startRounded] = aggregated
	}

	// Calculate average values
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

	markupIds := make([]int, 0, len(markupIdsMap))
	for markupId := range markupIdsMap {
		markupIds = append(markupIds, markupId)
	}

	return intervals, markupIds
}

func insertVideoCalculated(db *sql.DB, videoId string, intervals map[int]map[int]IntervalAggregated, markupIds []int) {
	var allData []map[string]interface{}
	var segmentsMeta = []map[string]interface{}{}

	i := 0
	for categoryId, level1 := range intervals {
		for _, level2 := range level1 {
			data := map[string]interface{}{
				"category_id": categoryId,
				"start":       level2.startAverage,
				"end":         level2.endAverage,
			}
			allData = append(allData, data)

			segmentsMeta = append(segmentsMeta, map[string]interface{}{"id": i, "markup_ids": level2.markupIds})
			i++
		}
	}

	jsonData, err := json.Marshal(allData)
	if err != nil {
		log.Fatalf("Ошибка при преобразовании в JSON: %v", err)
	}

	meta := map[string]interface{}{
		"markup_ids": markupIds,
		"segments":   segmentsMeta,
	}
	jsonMeta, err := json.Marshal(meta)
	if err != nil {
		log.Fatalf("Ошибка при преобразовании в JSON: %v", err)
	}

	insertVideoCalculatedSql := `
		INSERT INTO video_calculateds (video_id, data, meta, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, now(), now())
	`

	_, err = db.Exec(insertVideoCalculatedSql, videoId, jsonData, jsonMeta)
	if err != nil {
		panic(err)
	}
}

// TODO: Can be a problem if new markups will be added during calculation. Now we update all markups by videoId, need to update for specific markups.
func updateIsNew(db *sql.DB, videoId string) {
	sql := `
		UPDATE markups SET is_new = false
		WHERE video_id = $1 AND is_new = true
	`

	res, err := db.Query(sql, videoId)
	if err != nil {
		panic(err)
	}
	defer res.Close()
}

func connectDb() *sql.DB {
	if err := godotenv.Load("/app/.env"); err != nil {
		log.Fatalf("Can not load .env файл: %v", err)
	}

	psqlInfo := fmt.Sprintf("host=%s port=%d user=%s "+
		"password=%s dbname=%s sslmode=disable",
		os.Getenv("DB_HOST"), 5432, os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), os.Getenv("DB_NAME"))

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
