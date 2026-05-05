package calculator_test

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
	"odedohbest/video-calculate/calculator"
)

// Run: go test ./calculator -run TestIntegration -v
// Requires DB running with schema synced. Uses .env from project root.

type segment struct {
	CategoryID int `json:"category_id"`
	Start      int `json:"start"`
	End        int `json:"end"`
	Rating     int `json:"rating"`
}

// ── DB helpers ────────────────────────────────────────────────────────────────

func connectTestDB(t *testing.T) *sql.DB {
	t.Helper()
	for _, p := range []string{".env", "../.env"} {
		if _, err := os.Stat(p); err == nil {
			godotenv.Load(p)
			break
		}
	}
	dbName := os.Getenv("TEST_DB_NAME")
	if dbName == "" {
		dbName = os.Getenv("DB_NAME") + "_test"
	}
	dbHost := os.Getenv("TEST_DB_HOST")
	if dbHost == "" {
		dbHost = "localhost"
	}
	dsn := fmt.Sprintf("host=%s port=5432 user=%s password=%s dbname=%s sslmode=disable",
		dbHost, os.Getenv("DB_USER"), os.Getenv("DB_PASSWORD"), dbName)
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Ping(); err != nil {
		t.Fatalf("ping db: %v", err)
	}
	return db
}

func categoryID(t *testing.T, db *sql.DB, prefix, name string) int {
	t.Helper()
	var id int
	err := db.QueryRow(
		fmt.Sprintf(`SELECT id FROM %smarkup_categories WHERE category = $1`, prefix), name,
	).Scan(&id)
	if err != nil {
		t.Fatalf("category %q not found in %smarkup_categories: %v", name, prefix, err)
	}
	return id
}

func insertVideo(t *testing.T, db *sql.DB, prefix, nativeID string) int {
	t.Helper()
	var id int
	err := db.QueryRow(
		fmt.Sprintf(`INSERT INTO %svideos (native_id, "createdAt", "updatedAt") VALUES ($1, now(), now()) RETURNING id`, prefix),
		nativeID,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert video: %v", err)
	}
	return id
}

func insertMarkup(t *testing.T, db *sql.DB, prefix string, videoID, catID, start, end int) {
	t.Helper()
	var markupID int
	err := db.QueryRow(
		fmt.Sprintf(`INSERT INTO %smarkups (video_id, user_id, category_id, is_new, "createdAt", "updatedAt")
		             VALUES ($1, 'test_user', $2, true, now(), now()) RETURNING id`, prefix),
		videoID, catID,
	).Scan(&markupID)
	if err != nil {
		t.Fatalf("insert markup: %v", err)
	}
	_, err = db.Exec(
		fmt.Sprintf(`INSERT INTO %smarkup_time_intervals (markup_id, start, "end", "createdAt", "updatedAt")
		             VALUES ($1, $2, $3, now(), now())`, prefix),
		markupID, start, end,
	)
	if err != nil {
		t.Fatalf("insert interval: %v", err)
	}
}

func insertDeletedMarkup(t *testing.T, db *sql.DB, prefix string, videoID, catID, start, end int) {
	t.Helper()
	var markupID int
	err := db.QueryRow(
		fmt.Sprintf(`INSERT INTO %smarkups (video_id, user_id, category_id, is_new, deleted_at, "createdAt", "updatedAt")
		             VALUES ($1, 'test_user', $2, true, now(), now(), now()) RETURNING id`, prefix),
		videoID, catID,
	).Scan(&markupID)
	if err != nil {
		t.Fatalf("insert deleted markup: %v", err)
	}
	_, err = db.Exec(
		fmt.Sprintf(`INSERT INTO %smarkup_time_intervals (markup_id, start, "end", "createdAt", "updatedAt")
		             VALUES ($1, $2, $3, now(), now())`, prefix),
		markupID, start, end,
	)
	if err != nil {
		t.Fatalf("insert deleted interval: %v", err)
	}
}

func cleanupVideo(t *testing.T, db *sql.DB, prefix, nativeID string) {
	t.Helper()
	var videoID int
	err := db.QueryRow(
		fmt.Sprintf(`SELECT id FROM %svideos WHERE native_id = $1`, prefix), nativeID,
	).Scan(&videoID)
	if err == sql.ErrNoRows {
		return
	}
	if err != nil {
		t.Logf("cleanup find video: %v", err)
		return
	}
	provider := prefix
	if prefix == "" {
		provider = "prv"
	} else {
		provider = prefix[:len(prefix)-1]
	}
	segTable := provider + "_calculated_segments"
	segMarkupTable := provider + "_calculated_segment_markups"

	db.Exec(fmt.Sprintf(`DELETE FROM %smarkup_time_intervals WHERE markup_id IN
	    (SELECT id FROM %smarkups WHERE video_id = $1)`, prefix, prefix), videoID)
	db.Exec(fmt.Sprintf(`DELETE FROM %smarkups WHERE video_id = $1`, prefix), videoID)
	db.Exec(fmt.Sprintf(`DELETE FROM %svideo_calculateds WHERE video_id = $1`, prefix), videoID)
	db.Exec(fmt.Sprintf(`DELETE FROM %s WHERE segment_id IN (SELECT id FROM %s WHERE video_id = $1)`, segMarkupTable, segTable), videoID)
	db.Exec(fmt.Sprintf(`DELETE FROM %s WHERE video_id = $1`, segTable), videoID)
	db.Exec(fmt.Sprintf(`DELETE FROM %svideos WHERE id = $1`, prefix), videoID)
}

func getSegments(t *testing.T, db *sql.DB, prefix string, videoID int) []segment {
	t.Helper()
	var raw []byte
	err := db.QueryRow(
		fmt.Sprintf(`SELECT data FROM %svideo_calculateds WHERE video_id = $1`, prefix), videoID,
	).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		t.Fatalf("query video_calculateds: %v", err)
	}
	var segs []segment
	if err := json.Unmarshal(raw, &segs); err != nil {
		t.Fatalf("unmarshal segments: %v", err)
	}
	return segs
}

func findSeg(segs []segment, catID, start, end int) *segment {
	for i := range segs {
		if segs[i].CategoryID == catID && segs[i].Start == start && segs[i].End == end {
			return &segs[i]
		}
	}
	return nil
}

// ── Test cases ────────────────────────────────────────────────────────────────

func TestIntegration(t *testing.T) {
	db := connectTestDB(t)
	defer db.Close()

	// ── prv provider (prefix "") ───────────────────────────────────────────────

	introCat := categoryID(t, db, "", "intro")
	sponsorCat := categoryID(t, db, "", "sponsor")

	// Case 1: basic median
	// 3 markups in bucket 0, same category
	// startAvg = (0+1+2)/3 = 1
	// endMedian = sorted[10,11,12][1] = 11
	t.Run("PRV_basic_median", func(t *testing.T) {
		nid := "__test__PRV_basic_median"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 1, 12)
		insertMarkup(t, db, "", vid, introCat, 2, 11)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 1 {
			t.Fatalf("expected 1 segment, got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, introCat, 1, 11) == nil {
			t.Errorf("expected segment {cat=%d start=1 end=11}, got %+v", introCat, segs)
		}
	})

	// Case 2: outlier in end — median should ignore extreme value
	// ends=[10,12,100] → sorted[10,12,100][1] = 12
	t.Run("PRV_outlier_end", func(t *testing.T) {
		nid := "__test__PRV_outlier_end"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 1, 12)
		insertMarkup(t, db, "", vid, introCat, 2, 100)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 1 {
			t.Fatalf("expected 1 segment, got %d", len(segs))
		}
		if findSeg(segs, introCat, 1, 12) == nil {
			t.Errorf("expected end=12 (outlier 100 excluded by median), got %+v", segs)
		}
	})

	// Case 3: very big end difference with only 2 markups
	// With l=2: sorted[10,500][1] = 500 (upper median — documents this behavior)
	// startAvg = (0+1)/2 = 0
	t.Run("PRV_two_markups_upper_median", func(t *testing.T) {
		nid := "__test__PRV_two_upper_median"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 1, 500)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 1 {
			t.Fatalf("expected 1 segment, got %d", len(segs))
		}
		// With 2 values, FindMedian picks the upper one (index l/2 = 1)
		if findSeg(segs, introCat, 0, 500) == nil {
			t.Errorf("expected end=500 (upper median with 2 values), got %+v", segs)
		}
	})

	// Case 4: two 3-second buckets — starts 0-2 vs 3-5
	// Bucket 0: starts=[0,2] startAvg=1, ends=[10,11] endMedian=[10,11][1]=11
	// Bucket 3: starts=[3,5] startAvg=4, ends=[20,22] endMedian=[20,22][1]=22
	t.Run("PRV_two_buckets_0_and_3", func(t *testing.T) {
		nid := "__test__PRV_two_buckets"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 2, 11)
		insertMarkup(t, db, "", vid, introCat, 3, 20)
		insertMarkup(t, db, "", vid, introCat, 5, 22)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 2 {
			t.Fatalf("expected 2 segments, got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, introCat, 1, 11) == nil {
			t.Errorf("bucket 0 segment missing: %+v", segs)
		}
		if findSeg(segs, introCat, 4, 22) == nil {
			t.Errorf("bucket 3 segment missing: %+v", segs)
		}
	})

	// Case 5: three buckets — 0, 3, 6 seconds
	// Bucket 0: starts=[0,2] avg=1, ends=[10,11] median=11
	// Bucket 3: starts=[3,4] avg=3, ends=[20,21] median=21
	// Bucket 6: starts=[6,8] avg=7, ends=[30,32] median=32
	t.Run("PRV_three_buckets_0_3_6", func(t *testing.T) {
		nid := "__test__PRV_three_buckets"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 2, 11)
		insertMarkup(t, db, "", vid, introCat, 3, 20)
		insertMarkup(t, db, "", vid, introCat, 4, 21)
		insertMarkup(t, db, "", vid, introCat, 6, 30)
		insertMarkup(t, db, "", vid, introCat, 8, 32)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 3 {
			t.Fatalf("expected 3 segments, got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, introCat, 1, 11) == nil {
			t.Errorf("bucket 0 missing: %+v", segs)
		}
		if findSeg(segs, introCat, 3, 21) == nil {
			t.Errorf("bucket 3 missing: %+v", segs)
		}
		if findSeg(segs, introCat, 7, 32) == nil {
			t.Errorf("bucket 6 missing: %+v", segs)
		}
	})

	// Case 6: boundary — start=2 goes to bucket 0, start=3 goes to bucket 3
	// Must NOT be grouped together
	t.Run("PRV_bucket_boundary_2_and_3", func(t *testing.T) {
		nid := "__test__PRV_boundary"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 2, 10)
		insertMarkup(t, db, "", vid, introCat, 3, 20)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 2 {
			t.Fatalf("expected 2 segments (2 and 3 are in different buckets), got %d: %+v", len(segs), segs)
		}
	})

	// Case 7: different categories on same video — each category calculated independently
	// intro: starts=[0,1] avg=0, ends=[10,11] median=11
	// sponsor: starts=[30,31] avg=30, ends=[50,51] median=51
	t.Run("PRV_different_categories", func(t *testing.T) {
		nid := "__test__PRV_categories"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 1, 11)
		insertMarkup(t, db, "", vid, sponsorCat, 30, 50)
		insertMarkup(t, db, "", vid, sponsorCat, 31, 51)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 2 {
			t.Fatalf("expected 2 segments (intro + sponsor), got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, introCat, 0, 11) == nil {
			t.Errorf("intro segment missing: %+v", segs)
		}
		if findSeg(segs, sponsorCat, 30, 51) == nil {
			t.Errorf("sponsor segment missing: %+v", segs)
		}
	})

	// Case 8: deleted markup excluded from calculation
	// 3 active markups + 1 deleted with extreme end (would change median if included)
	// Active: starts=[0,1,2] ends=[10,11,12] → start=1, end=11
	// Deleted: start=1, end=999 (would shift median to 12 if included)
	t.Run("PRV_deleted_markup_excluded", func(t *testing.T) {
		nid := "__test__PRV_deleted"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 10)
		insertMarkup(t, db, "", vid, introCat, 1, 11)
		insertMarkup(t, db, "", vid, introCat, 2, 12)
		insertDeletedMarkup(t, db, "", vid, introCat, 1, 999)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 1 {
			t.Fatalf("expected 1 segment, got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, introCat, 1, 11) == nil {
			t.Errorf("expected end=11 (deleted markup with end=999 must be excluded), got %+v", segs)
		}
	})

	// Case 9: single markup — passthrough, no averaging
	// start=5, bucket=3 (5-5%3=3), startAvg=5, end=30
	t.Run("PRV_single_markup", func(t *testing.T) {
		nid := "__test__PRV_single"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 5, 30)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 1 {
			t.Fatalf("expected 1 segment, got %d", len(segs))
		}
		if findSeg(segs, introCat, 5, 30) == nil {
			t.Errorf("expected {start=5 end=30}, got %+v", segs)
		}
	})

	// Case 10: 5 markups — median picks true middle
	// ends=[1,3,5,7,100] sorted → index 2 = 5
	// starts=[0,0,0,0,0] avg=0
	t.Run("PRV_five_markups_true_median", func(t *testing.T) {
		nid := "__test__PRV_five"
		t.Cleanup(func() { cleanupVideo(t, db, "", nid) })
		vid := insertVideo(t, db, "", nid)
		insertMarkup(t, db, "", vid, introCat, 0, 1)
		insertMarkup(t, db, "", vid, introCat, 0, 3)
		insertMarkup(t, db, "", vid, introCat, 0, 5)
		insertMarkup(t, db, "", vid, introCat, 0, 7)
		insertMarkup(t, db, "", vid, introCat, 0, 100)

		calculator.Run("")

		segs := getSegments(t, db, "", vid)
		if len(segs) != 1 {
			t.Fatalf("expected 1 segment, got %d", len(segs))
		}
		if findSeg(segs, introCat, 0, 5) == nil {
			t.Errorf("expected end=5 (true middle of 5 values), got %+v", segs)
		}
	})

	// ── RT provider ──────────────────────────────────────────────────────────

	rtIntroCat := categoryID(t, db, "rt_", "intro")
	rtSponsorCat := categoryID(t, db, "rt_", "sponsor")

	// Case 11: RT two buckets + two categories
	t.Run("RT_two_buckets_two_categories", func(t *testing.T) {
		nid := "__test__RT_full"
		t.Cleanup(func() { cleanupVideo(t, db, "rt_", nid) })
		vid := insertVideo(t, db, "rt_", nid)
		// intro bucket 0: starts=[0,2] avg=1, ends=[10,11] median=11
		insertMarkup(t, db, "rt_", vid, rtIntroCat, 0, 10)
		insertMarkup(t, db, "rt_", vid, rtIntroCat, 2, 11)
		// sponsor bucket 6: starts=[6,7] avg=6, ends=[40,42] median=42
		insertMarkup(t, db, "rt_", vid, rtSponsorCat, 6, 40)
		insertMarkup(t, db, "rt_", vid, rtSponsorCat, 7, 42)

		calculator.Run("rt_")

		segs := getSegments(t, db, "rt_", vid)
		if len(segs) != 2 {
			t.Fatalf("expected 2 segments, got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, rtIntroCat, 1, 11) == nil {
			t.Errorf("RT intro segment missing: %+v", segs)
		}
		if findSeg(segs, rtSponsorCat, 6, 42) == nil {
			t.Errorf("RT sponsor segment missing: %+v", segs)
		}
	})

	// Case 12: RT isolated from prv — inserting in RT tables must not affect prv
	t.Run("RT_isolated_from_prv", func(t *testing.T) {
		nidRT := "__test__RT_isolation"
		nidPrv := "__test__PRV_isolation"
		t.Cleanup(func() {
			cleanupVideo(t, db, "rt_", nidRT)
			cleanupVideo(t, db, "", nidPrv)
		})

		rtVid := insertVideo(t, db, "rt_", nidRT)
		insertMarkup(t, db, "rt_", rtVid, rtIntroCat, 0, 10)

		calculator.Run("rt_")

		// prv tables must have no new video_calculateds for this native_id
		var count int
		db.QueryRow(`SELECT COUNT(*) FROM videos WHERE native_id = $1`, nidRT).Scan(&count)
		if count != 0 {
			t.Errorf("RT data leaked into prv videos table")
		}
	})

	// ── YT provider ──────────────────────────────────────────────────────────

	ytIntroCat := categoryID(t, db, "yt_", "intro")

	// Case 13: YT outlier end + three buckets
	t.Run("YT_outlier_and_three_buckets", func(t *testing.T) {
		nid := "__test__YT_full"
		t.Cleanup(func() { cleanupVideo(t, db, "yt_", nid) })
		vid := insertVideo(t, db, "yt_", nid)
		// Bucket 0: ends=[5,6,999] median=[5,6,999][1]=6
		insertMarkup(t, db, "yt_", vid, ytIntroCat, 0, 5)
		insertMarkup(t, db, "yt_", vid, ytIntroCat, 1, 999)
		insertMarkup(t, db, "yt_", vid, ytIntroCat, 2, 6)
		// Bucket 3: single markup
		insertMarkup(t, db, "yt_", vid, ytIntroCat, 4, 20)
		// Bucket 9: starts=[9,11] avg=10, ends=[30,31] median=31
		insertMarkup(t, db, "yt_", vid, ytIntroCat, 9, 30)
		insertMarkup(t, db, "yt_", vid, ytIntroCat, 11, 31)

		calculator.Run("yt_")

		segs := getSegments(t, db, "yt_", vid)
		if len(segs) != 3 {
			t.Fatalf("expected 3 segments, got %d: %+v", len(segs), segs)
		}
		if findSeg(segs, ytIntroCat, 1, 6) == nil {
			t.Errorf("bucket 0 segment (outlier excluded) missing: %+v", segs)
		}
		if findSeg(segs, ytIntroCat, 4, 20) == nil {
			t.Errorf("bucket 3 single markup segment missing: %+v", segs)
		}
		if findSeg(segs, ytIntroCat, 10, 31) == nil {
			t.Errorf("bucket 9 segment missing: %+v", segs)
		}
	})
}
