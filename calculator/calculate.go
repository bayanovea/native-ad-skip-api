package calculator

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

func Run(tablePrefix string) {
	db := ConnectDb()
	defer db.Close()

	videoIds := getVideoIds(db, tablePrefix)
	pool := NewGoroutinePool(10)

	for _, videoId := range videoIds {
		id := videoId
		pool.Execute(func() {
			calculateVideo(id, db, tablePrefix)
		})
	}

	pool.Close()
}

func getVideoIds(db *sql.DB, tablePrefix string) []string {
	args := os.Args[1:]

	if len(args) == 0 {
		return getVideoIdsWithNewMarkups(db, tablePrefix)
	}

	return []string{args[0]}
}

func getVideoIdsWithNewMarkups(db *sql.DB, tablePrefix string) []string {
	sql := fmt.Sprintf(`
		SELECT DISTINCT video_id FROM %smarkups
		WHERE is_new = true AND deleted_at IS NULL
	`, tablePrefix)

	rows, err := db.Query(sql)
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

func calculateVideo(videoId string, db *sql.DB, tablePrefix string) {
	fmt.Println("Calculate video start: ", videoId)

	clearOldVideoCalculated(db, videoId, tablePrefix)
	intervals, markupIds := CalculateIntervals(db, videoId, tablePrefix)
	insertVideoCalculated(db, videoId, intervals, markupIds, tablePrefix)
	updateIsNew(db, videoId, tablePrefix)

	fmt.Println("Calculate video finish: ", videoId)
}

func clearOldVideoCalculated(db *sql.DB, videoId string, tablePrefix string) {
	sql := fmt.Sprintf(`
		DELETE FROM %svideo_calculateds
		WHERE video_id = $1
	`, tablePrefix)

	_, err := db.Query(sql, videoId)
	if err != nil {
		panic(err)
	}
}

func CalculateIntervals(db *sql.DB, videoId string, tablePrefix string) (map[int]map[int]IntervalAggregated, []int) {
	sql := fmt.Sprintf(`
  	SELECT intervals.start, intervals.end, categories.id category_id, markups.id markup_id FROM %smarkup_time_intervals intervals
		LEFT JOIN %smarkups ON %smarkups.id = intervals.markup_id
		LEFT JOIN %smarkup_categories categories ON categories.id = %smarkups.category_id
		WHERE %smarkups.video_id = $1 AND intervals.deleted_at IS NULL AND %smarkups.deleted_at IS NULL
		ORDER BY intervals.start
	`, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix)

	videos, err := db.Query(sql, videoId)
	if err != nil {
		panic(err)
	}
	defer videos.Close()

	markupIdsMap := make(map[int]bool)
	intervals := make(map[int]map[int]IntervalAggregated)

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

	for categoryId, level1 := range intervals {
		for startRounded, level2 := range level1 {
			startSum := 0
			endNumbers := make([]int, 0, len(level2.intervals))

			for _, interval := range level2.intervals {
				startSum += interval.start
				endNumbers = append(endNumbers, interval.end)
			}

			startAverage := startSum / len(level2.intervals)
			endAverage := FindMedian(endNumbers)

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

func insertVideoCalculated(db *sql.DB, videoId string, intervals map[int]map[int]IntervalAggregated, markupIds []int, tablePrefix string) {
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
		log.Fatalf("JSON marshal error: %v", err)
	}

	meta := map[string]interface{}{
		"markup_ids": markupIds,
		"segments":   segmentsMeta,
	}
	jsonMeta, err := json.Marshal(meta)
	if err != nil {
		log.Fatalf("JSON marshal error: %v", err)
	}

	sql := fmt.Sprintf(`
		INSERT INTO %svideo_calculateds (video_id, data, meta, "createdAt", "updatedAt")
		VALUES ($1, $2, $3, now(), now())
	`, tablePrefix)

	_, err = db.Exec(sql, videoId, jsonData, jsonMeta)
	if err != nil {
		panic(err)
	}
}

// TODO: Can be a problem if new markups will be added during calculation. Now we update all markups by videoId, need to update for specific markups.
func updateIsNew(db *sql.DB, videoId string, tablePrefix string) {
	sql := fmt.Sprintf(`
		UPDATE %smarkups SET is_new = false
		WHERE video_id = $1 AND is_new = true AND deleted_at IS NULL
	`, tablePrefix)

	res, err := db.Query(sql, videoId)
	if err != nil {
		panic(err)
	}
	defer res.Close()
}

func ConnectDb() *sql.DB {
	if err := godotenv.Load("/app/.env"); err != nil {
		log.Fatalf("Can not load .env: %v", err)
	}

	psqlInfo := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
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

func FindMedian(nums []int) int {
	l := len(nums)

	if l == 0 {
		return 0
	}

	sort.Ints(nums)

	return nums[int(l/2)]
}
