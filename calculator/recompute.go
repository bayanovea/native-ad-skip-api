package calculator

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"sync"
)

// RecomputeRatings sets every calculated segment's rating from the votes table
// (voteRatings), in the segments table and in video_calculateds.data. It never
// touches segment boundaries, markups or is_new. Each video runs in its own
// transaction; a failing one is logged and the others go on, and the error
// returned makes the binary exit non-zero. A second run changes nothing.
func RecomputeRatings(tablePrefix string) error {
	db := ConnectDb()
	defer db.Close()

	ids, err := getCalculatedVideoIds(db, tablePrefix)
	if err != nil {
		return fmt.Errorf("list calculated videos: %w", err)
	}

	pool := NewGoroutinePool(10)

	var mu sync.Mutex
	failed, segmentsChanged, jsonChanged := 0, 0, 0

	for _, id := range ids {
		id := id
		pool.Execute(func() {
			segments, jsonRewritten, err := recomputeVideoRatings(id, db, tablePrefix)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				log.Printf("Recompute ratings failed: %s: %v", id, err)
				failed++
				return
			}
			segmentsChanged += segments
			if jsonRewritten {
				jsonChanged++
			}
		})
	}

	pool.Close()

	fmt.Printf("Recompute ratings finish: %d videos processed, %d segments changed, %d video_calculateds rewritten\n",
		len(ids)-failed, segmentsChanged, jsonChanged)

	if failed > 0 {
		return fmt.Errorf("%d of %d videos failed", failed, len(ids))
	}
	return nil
}

func getCalculatedVideoIds(db *sql.DB, tablePrefix string) ([]string, error) {
	rows, err := db.Query(fmt.Sprintf(`SELECT DISTINCT video_id FROM %svideo_calculateds`, tablePrefix))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}

	return ids, rows.Err()
}

// recomputeVideoRatings returns how many segment rows changed and whether the
// video_calculateds JSON was rewritten.
func recomputeVideoRatings(videoId string, db *sql.DB, tablePrefix string) (int, bool, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, false, fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback() // no-op after Commit

	// The row lock serialises with a recalculation of the same video and with
	// the vote handler, which both lock this row first.
	type calculatedRow struct {
		id   int64
		data []byte
	}
	rows, err := tx.Query(fmt.Sprintf(`
		SELECT id, data FROM %svideo_calculateds WHERE video_id = $1 ORDER BY id FOR UPDATE
	`, tablePrefix), videoId)
	if err != nil {
		return 0, false, fmt.Errorf("lock video calculated: %w", err)
	}
	var calculated []calculatedRow
	for rows.Next() {
		var r calculatedRow
		if err := rows.Scan(&r.id, &r.data); err != nil {
			rows.Close()
			return 0, false, fmt.Errorf("lock video calculated: %w", err)
		}
		calculated = append(calculated, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, false, fmt.Errorf("lock video calculated: %w", err)
	}
	// A recalculation that held the row replaced it, with fresh ratings.
	if len(calculated) == 0 {
		return 0, false, nil
	}

	ratings, err := voteRatings(tx, videoId, tablePrefix)
	if err != nil {
		return 0, false, err
	}

	segmentsChanged, err := updateSegmentRatings(tx, videoId, ratings, tablePrefix)
	if err != nil {
		return 0, false, err
	}

	jsonRewritten := false
	for _, r := range calculated {
		newData, changed, err := applyRatings(r.data, ratings)
		if err != nil {
			return 0, false, fmt.Errorf("video calculated %d: %w", r.id, err)
		}
		if !changed {
			continue
		}
		if _, err := tx.Exec(fmt.Sprintf(`
			UPDATE %svideo_calculateds SET data = $1, "updatedAt" = now() WHERE id = $2
		`, tablePrefix), newData, r.id); err != nil {
			return 0, false, fmt.Errorf("update video calculated: %w", err)
		}
		jsonRewritten = true
	}

	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("commit: %w", err)
	}
	return segmentsChanged, jsonRewritten, nil
}

func updateSegmentRatings(tx *sql.Tx, videoId string, ratings map[segmentKey]int, tablePrefix string) (int, error) {
	segmentsTable := providerName(tablePrefix) + "_calculated_segments"

	rows, err := tx.Query(fmt.Sprintf(`
		SELECT id, category_id, start, "end", rating FROM %s WHERE video_id = $1
	`, segmentsTable), videoId)
	if err != nil {
		return 0, fmt.Errorf("read segments: %w", err)
	}
	changed := map[int64]int{}
	for rows.Next() {
		var id int64
		var categoryId, start, end int
		var rating sql.NullInt64
		if err := rows.Scan(&id, &categoryId, &start, &end, &rating); err != nil {
			rows.Close()
			return 0, fmt.Errorf("read segments: %w", err)
		}
		want := ratings[keyOf(categoryId, start, end)]
		if !rating.Valid || int(rating.Int64) != want {
			changed[id] = want
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("read segments: %w", err)
	}

	for id, rating := range changed {
		if _, err := tx.Exec(fmt.Sprintf(`
			UPDATE %s SET rating = $1, "updatedAt" = now() WHERE id = $2
		`, segmentsTable), rating, id); err != nil {
			return 0, fmt.Errorf("update segment: %w", err)
		}
	}

	return len(changed), nil
}

// applyRatings rewrites the rating of every entry of a video_calculateds.data
// array from ratings (omitted when 0). Entry order and every other field are
// kept (numbers are not reformatted); changed is false when no rating differs.
func applyRatings(data []byte, ratings map[segmentKey]int) ([]byte, bool, error) {
	if len(bytes.TrimSpace(data)) == 0 || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return data, false, nil
	}

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var entries []map[string]interface{}
	if err := dec.Decode(&entries); err != nil {
		return nil, false, fmt.Errorf("decode data: %w", err)
	}

	changed := false
	for _, entry := range entries {
		categoryId, okC := jsonInt(entry["category_id"])
		start, okS := jsonFloat(entry["start"])
		end, okE := jsonFloat(entry["end"])
		want := 0
		if okC && okS && okE {
			want = ratings[segmentKey{int(categoryId), start, end}]
		}

		current, hasRating := entry["rating"]
		currentValue, okR := jsonInt(current)
		if want == 0 {
			if hasRating {
				delete(entry, "rating")
				changed = true
			}
			continue
		}
		if !hasRating || !okR || int(currentValue) != want {
			entry["rating"] = want
			changed = true
		}
	}

	if !changed {
		return data, false, nil
	}
	out, err := json.Marshal(entries)
	if err != nil {
		return nil, false, fmt.Errorf("encode data: %w", err)
	}
	return out, true, nil
}

func jsonFloat(v interface{}) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	return f, err == nil
}

func jsonInt(v interface{}) (int64, bool) {
	f, ok := jsonFloat(v)
	if !ok || f != float64(int64(f)) {
		return 0, false
	}
	return int64(f), true
}
