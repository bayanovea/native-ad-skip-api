package calculator

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"sync"

	"github.com/joho/godotenv"
	"github.com/lib/pq"
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

// querier is satisfied by both *sql.DB and *sql.Tx.
type querier interface {
	Query(query string, args ...interface{}) (*sql.Rows, error)
}

// Run recalculates every video with new markups, or only videoId when given.
// A video that fails is logged and rolled back while the others go on; Run
// returns an error when any video failed, so the binary exits non-zero.
func Run(tablePrefix string, videoId ...string) error {
	db := ConnectDb()
	defer db.Close()

	var ids []string
	if len(videoId) > 0 && videoId[0] != "" {
		ids = []string{videoId[0]}
	} else {
		var err error
		ids, err = getVideoIdsWithNewMarkups(db, tablePrefix)
		if err != nil {
			return fmt.Errorf("list videos with new markups: %w", err)
		}
	}

	pool := NewGoroutinePool(10)

	var mu sync.Mutex
	failed := 0

	for _, id := range ids {
		id := id
		pool.Execute(func() {
			if err := calculateVideo(id, db, tablePrefix); err != nil {
				log.Printf("Calculate video failed: %s: %v", id, err)
				mu.Lock()
				failed++
				mu.Unlock()
			}
		})
	}

	pool.Close()

	if failed > 0 {
		return fmt.Errorf("%d of %d videos failed", failed, len(ids))
	}
	return nil
}

func getVideoIdsWithNewMarkups(db *sql.DB, tablePrefix string) ([]string, error) {
	sql := fmt.Sprintf(`
		SELECT DISTINCT video_id FROM %smarkups
		WHERE is_new = true AND deleted_at IS NULL
	`, tablePrefix)

	rows, err := db.Query(sql)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var videoIds []string
	for rows.Next() {
		var videoId string
		if err := rows.Scan(&videoId); err != nil {
			return nil, err
		}

		videoIds = append(videoIds, videoId)
	}

	return videoIds, rows.Err()
}

func providerName(tablePrefix string) string {
	if tablePrefix == "" {
		return "prv"
	}
	return tablePrefix[:len(tablePrefix)-1]
}

// calculateVideo replaces the video's calculated segments in one transaction:
// any error rolls it back, so the previous segments stay as they were.
func calculateVideo(videoId string, db *sql.DB, tablePrefix string) error {
	fmt.Println("Calculate video start: ", videoId)

	tx, err := db.Begin()
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() // no-op after Commit

	newMarkupIds, err := lockNewMarkups(tx, videoId, tablePrefix)
	if err != nil {
		return err
	}
	intervals, err := CalculateIntervals(tx, videoId, tablePrefix)
	if err != nil {
		return err
	}
	if err := clearOldVideoCalculated(tx, videoId, tablePrefix); err != nil {
		return err
	}
	if err := insertVideoCalculated(tx, videoId, intervals, tablePrefix); err != nil {
		return err
	}
	if err := insertCalculatedSegments(tx, videoId, intervals, tablePrefix); err != nil {
		return err
	}
	if err := updateIsNew(tx, newMarkupIds, tablePrefix); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	fmt.Println("Calculate video finish: ", videoId)
	return nil
}

// lockNewMarkups returns the ids of the video's new markups, the only ones
// updateIsNew marks as processed. It runs before the interval read, so a markup
// committed in between is aggregated but stays is_new (recalculated next run)
// rather than being marked without its intervals read. The rows stay locked
// until commit, so a concurrent edit or delete that sets is_new = true again
// waits and wins. Rows another transaction holds now are skipped (not waited
// for, so no deadlock with the API): they stay is_new for the next run.
func lockNewMarkups(tx *sql.Tx, videoId string, tablePrefix string) ([]int64, error) {
	rows, err := tx.Query(fmt.Sprintf(`
		SELECT id FROM %smarkups
		WHERE video_id = $1 AND is_new = true AND deleted_at IS NULL
		FOR NO KEY UPDATE SKIP LOCKED
	`, tablePrefix), videoId)
	if err != nil {
		return nil, fmt.Errorf("lock new markups: %w", err)
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("lock new markups: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("lock new markups: %w", err)
	}

	return ids, nil
}

func clearOldVideoCalculated(tx *sql.Tx, videoId string, tablePrefix string) error {
	provider := providerName(tablePrefix)
	segmentsTable := provider + "_calculated_segments"
	markupsTable := provider + "_calculated_segment_markups"

	if _, err := tx.Exec(fmt.Sprintf(`
		DELETE FROM %s WHERE segment_id IN (SELECT id FROM %s WHERE video_id = $1)
	`, markupsTable, segmentsTable), videoId); err != nil {
		return fmt.Errorf("clear segment markups: %w", err)
	}

	if _, err := tx.Exec(fmt.Sprintf(`DELETE FROM %s WHERE video_id = $1`, segmentsTable), videoId); err != nil {
		return fmt.Errorf("clear segments: %w", err)
	}

	if _, err := tx.Exec(fmt.Sprintf(`DELETE FROM %svideo_calculateds WHERE video_id = $1`, tablePrefix), videoId); err != nil {
		return fmt.Errorf("clear video calculated: %w", err)
	}

	return nil
}

func CalculateIntervals(q querier, videoId string, tablePrefix string) (map[int]map[int]IntervalAggregated, error) {
	sql := fmt.Sprintf(`
  	SELECT intervals.start, intervals.end, categories.id category_id, %smarkups.id markup_id FROM %smarkup_time_intervals intervals
		LEFT JOIN %smarkups ON %smarkups.id = intervals.markup_id
		LEFT JOIN %smarkup_categories categories ON categories.id = %smarkups.category_id
		WHERE %smarkups.video_id = $1 AND intervals.deleted_at IS NULL AND %smarkups.deleted_at IS NULL
		ORDER BY intervals.start
	`, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix, tablePrefix)

	videos, err := q.Query(sql, videoId)
	if err != nil {
		return nil, fmt.Errorf("read intervals: %w", err)
	}
	defer videos.Close()

	intervals := make(map[int]map[int]IntervalAggregated)

	for videos.Next() {
		var start, end, categoryId, markupId int

		err := videos.Scan(&start, &end, &categoryId, &markupId)
		if err != nil {
			return nil, fmt.Errorf("read intervals: %w", err)
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
	if err := videos.Err(); err != nil {
		return nil, fmt.Errorf("read intervals: %w", err)
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

	return intervals, nil
}

func insertVideoCalculated(tx *sql.Tx, videoId string, intervals map[int]map[int]IntervalAggregated, tablePrefix string) error {
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
		return fmt.Errorf("marshal video calculated: %w", err)
	}

	sql := fmt.Sprintf(`
		INSERT INTO %svideo_calculateds (video_id, data, "createdAt", "updatedAt")
		VALUES ($1, $2, now(), now())
	`, tablePrefix)

	if _, err := tx.Exec(sql, videoId, jsonData); err != nil {
		return fmt.Errorf("insert video calculated: %w", err)
	}

	return nil
}

func insertCalculatedSegments(tx *sql.Tx, videoId string, intervals map[int]map[int]IntervalAggregated, tablePrefix string) error {
	provider := providerName(tablePrefix)
	segmentsTable := provider + "_calculated_segments"
	markupsTable := provider + "_calculated_segment_markups"

	for categoryId, level1 := range intervals {
		for _, level2 := range level1 {
			var segmentId int
			err := tx.QueryRow(fmt.Sprintf(`
				INSERT INTO %s (video_id, category_id, start, "end", rating, "createdAt", "updatedAt")
				VALUES ($1, $2, $3, $4, 0, now(), now())
				RETURNING id
			`, segmentsTable), videoId, categoryId, level2.startAverage, level2.endAverage).Scan(&segmentId)
			if err != nil {
				return fmt.Errorf("insert segment: %w", err)
			}

			for _, markupId := range level2.markupIds {
				if _, err := tx.Exec(fmt.Sprintf(`
					INSERT INTO %s (segment_id, markup_id, "createdAt", "updatedAt")
					VALUES ($1, $2, now(), now())
				`, markupsTable), segmentId, markupId); err != nil {
					return fmt.Errorf("insert segment markup: %w", err)
				}
			}
		}
	}

	return nil
}

// updateIsNew marks only the markups lockNewMarkups returned as processed;
// markups inserted (or re-flagged) after that read stay is_new for the next run.
func updateIsNew(tx *sql.Tx, markupIds []int64, tablePrefix string) error {
	if len(markupIds) == 0 {
		return nil
	}

	sql := fmt.Sprintf(`UPDATE %smarkups SET is_new = false WHERE id = ANY($1)`, tablePrefix)

	if _, err := tx.Exec(sql, pq.Array(markupIds)); err != nil {
		return fmt.Errorf("update is_new: %w", err)
	}

	return nil
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
