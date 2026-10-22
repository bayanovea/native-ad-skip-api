package pipeline

import (
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"

	"odedohbest/video-calculate/ai/vtt"
)

func TestTimelineGate(t *testing.T) {
	cues := []vtt.Cue{{Start: 0, End: 4, Text: "a"}, {Start: 590, End: 602.9, Text: "b"}}
	if o := overrun(cues, 600); !timelineOK(o) {
		t.Fatalf("overrun %.1f: want the track accepted", o)
	}
	cues[1].End = 603.1
	if o := overrun(cues, 600); timelineOK(o) {
		t.Fatalf("overrun %.1f: want timeline_unreliable", o)
	}
	if o := overrun(cues, 700); !timelineOK(o) {
		t.Fatal("a track ending well before the video is fine (outro without speech)")
	}
}

func TestDurationVariants(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(regexp.QuoteMeta("SELECT COUNT(*) FROM videos WHERE native_id = $1 AND ABS(duration - $2::float8) > $3")).
		WithArgs("-1_456000001", 600.4, 2).
		WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	n, err := durationVariants(db, "-1_456000001", 600.4)
	if err != nil || n != 1 {
		t.Fatalf("got %d, %v", n, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestFindOrCreateVideo(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// a row within ±2 wins
	mock.ExpectQuery(regexp.QuoteMeta("ORDER BY ABS(duration - $2::int), id LIMIT 1")).WithArgs("-1_456000001", 600, 2).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(7))
	if id, ok, err := findOrCreateVideo(db, "-1_456000001", 600); err != nil || !ok || id != 7 {
		t.Fatalf("tolerance match: got %d %v %v", id, ok, err)
	}

	// none, but players reported another duration: yt-dlp sees another cut
	mock.ExpectQuery("ORDER BY ABS").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT EXISTS (SELECT 1 FROM videos WHERE native_id = $1 AND duration IS NOT NULL)")).
		WithArgs("-1_456000001").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	if _, ok, err := findOrCreateVideo(db, "-1_456000001", 600); err != nil || ok {
		t.Fatalf("another cut: got %v %v", ok, err)
	}

	// none: the row without a duration takes it
	mock.ExpectQuery("ORDER BY ABS").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock.ExpectQuery("SELECT EXISTS").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectQuery(regexp.QuoteMeta(`UPDATE videos SET duration = $2`)).WithArgs("-1_456000001", 600).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(8))
	if id, ok, err := findOrCreateVideo(db, "-1_456000001", 600); err != nil || !ok || id != 8 {
		t.Fatalf("null duration: got %d %v %v", id, ok, err)
	}

	// neither: a new row
	mock.ExpectQuery("ORDER BY ABS").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock.ExpectQuery("SELECT EXISTS").WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	mock.ExpectQuery("UPDATE videos").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock.ExpectQuery(regexp.QuoteMeta("INSERT INTO videos")).WithArgs("-1_456000001", 600).
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(9))
	if id, ok, err := findOrCreateVideo(db, "-1_456000001", 600); err != nil || !ok || id != 9 {
		t.Fatalf("new row: got %d %v %v", id, ok, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
