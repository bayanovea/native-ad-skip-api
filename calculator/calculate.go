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

func Run(tablePrefix string, videoId ...string) {
	db := ConnectDb()
	defer db.Close()

	var ids []string
	if len(videoId) > 0 && videoId[0] != "" {
		ids = []string{videoId[0]}
	} else {
		ids = getVideoIdsWithNewMarkups(db, tablePrefix)
	}

	pool := NewGoroutinePool(10)

	for _, id := range ids {
		id := id
		pool.Execute(func() {
			calculateVideo(id, db, tablePrefix)
		})
	}

	pool.Close()
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

func providerName(tablePrefix string) string {
	if tablePrefix == "" {
		return "prv"
	}
	return tablePrefix[:len(tablePrefix)-1]
}

func calculateVideo(videoId string, db *sql.DB, tablePrefix string) {
	fmt.Println("Calculate video start: ", videoId)

	clearOldVideoCalculated(db, videoId, tablePrefix)
	intervals := CalculateIntervals(db, videoId, tablePrefix)
	insertVideoCalculated(db, videoId, intervals, tablePrefix)
	insertCalculatedSegments(db, videoId, intervals, tablePrefix)
	updateIsNew(db, videoId, tablePrefix)

	fmt.Println("Calculate video finish: ", videoId)
}

func clearOldVideoCalculated(db *sql.DB, videoId string, tablePrefix string) {
	provider := providerName(tablePrefix)
	segmentsTable := provider + "_calculated_segments"
	markupsTable := provider + "_calculated_segment_markups"

	if _, err := db.Exec(fmt.Sprintf(`
		DELETE FROM %s WHERE segment_id IN (SELECT id FROM %s WHERE video_id = $1)
	`, markupsTable, segmentsTable), videoId); err != nil {
		log.Printf("clearOldVideoCalculated: failed to clear segment markups: %v", err)
	}

	if _, err := db.Exec(fmt.Sprintf(`DELETE FROM %s WHERE video_id = $1`, segmentsTable), videoId); err != nil {
		log.Printf("clearOldVideoCalculated: failed to clear segments: %v", err)
	}

	if _, err := db.Exec(fmt.Sprintf(`DELETE FROM %svideo_calculateds WHERE video_id = $1`, tablePrefix), videoId); err != nil {
		panic(err)
	}
}

func CalculateIntervals(db *sql.DB, videoId string, tablePrefix string) map[int]map[int]IntervalAggregated {
	sql := fmt.Sprintf(`
  	SELECT intervals.start, intervals.end, categories.id category_id, %smarkups.id markup_id FROM %smarkup_time_intervals intervals
		LEFT JOIN %smarkups ON %smarkups.id = intervals.markup_id
		LEFT JOIN %smarkup_categories categories ON categories.id = %smarkups.category_id
		WHERE %smarkups.video_id = $1 AND intervals.deleted_at IS NULL AND %smarkups.deleted_at IS NULL
		ORDER BY intervals.start
	`, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix)

	videos, err := db.Query(sql, videoId)
	if err != nil {
		panic(err)
	}
	defer videos.Close()

	intervals := make(map[int]map[int]IntervalAggregated)

	for videos.Next() {
		var start, end, categoryId, markupId int

		err := videos.Scan(&start, &end, &categoryId, &markupId)
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

	return intervals
}

func insertVideoCalculated(db *sql.DB, videoId string, intervals map[int]map[int]IntervalAggregated, tablePrefix string) {
	var allData []map[string]interface{}

	for categoryId, level1 := range intervals {
		for _, level2 := range level1 {
			allData = append(allData, map[string]interface{}{
				"category_id": categoryId,
				"start":       level2.startAverage,
				"end":         level2.endAverage,
			})
		}
	}

	jsonData, err := json.Marshal(allData)
	if err != nil {
		log.Fatalf("JSON marshal error: %v", err)
	}

	sql := fmt.Sprintf(`
		INSERT INTO %svideo_calculateds (video_id, data, "createdAt", "updatedAt")
		VALUES ($1, $2, now(), now())
	`, tablePrefix)

	_, err = db.Exec(sql, videoId, jsonData)
	if err != nil {
		panic(err)
	}
}

func insertCalculatedSegments(db *sql.DB, videoId string, intervals map[int]map[int]IntervalAggregated, tablePrefix string) {
	provider := providerName(tablePrefix)
	segmentsTable := provider + "_calculated_segments"
	markupsTable := provider + "_calculated_segment_markups"

	for categoryId, level1 := range intervals {
		for _, level2 := range level1 {
			var segmentId int
			err := db.QueryRow(fmt.Sprintf(`
				INSERT INTO %s (video_id, category_id, start, "end", rating, "createdAt", "updatedAt")
				VALUES ($1, $2, $3, $4, 0, now(), now())
				RETURNING id
			`, segmentsTable), videoId, categoryId, level2.startAverage, level2.endAverage).Scan(&segmentId)
			if err != nil {
				log.Printf("insertCalculatedSegments: failed to insert segment: %v", err)
				continue
			}

			for _, markupId := range level2.markupIds {
				if _, err := db.Exec(fmt.Sprintf(`
					INSERT INTO %s (segment_id, markup_id, "createdAt", "updatedAt")
					VALUES ($1, $2, now(), now())
				`, markupsTable), segmentId, markupId); err != nil {
					log.Printf("insertCalculatedSegments: failed to insert segment markup: %v", err)
				}
			}
		}
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
	godotenv.Load("/app/.env") // non-fatal; env vars already set take precedence

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
