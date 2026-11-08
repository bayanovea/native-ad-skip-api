package pipeline

import (
	"reflect"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestParseChapters(t *testing.T) {
	got := parseChapters("-1_456000001", []byte(`{"id":"x","chapters":[{"start_time":0,"end_time":307,"title":"Вступление"},{"start_time":307,"end_time":437.5,"title":"Реклама"}]}`))
	want := []chapter{{0, 307, "Вступление"}, {307, 437.5, "Реклама"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if got := parseChapters("-1_456000001", []byte(`{"id":"x"}`)); got == nil || len(got) != 0 {
		t.Fatalf("no chapters: got %#v, want an empty list", got)
	}
	if got := parseChapters("-1_456000001", []byte(`{"chapters":"x"}`)); got != nil {
		t.Fatalf("unparsable: got %#v, want nil", got)
	}
}

func TestApplyChapters(t *testing.T) {
	ai := func(start, end int) Entry { return re(2, start, end, "high", "ai", "", 0) }
	moved := func(start, end int) Entry { return re(2, start, end, "high", sourceChapter, "", 0) }
	for _, c := range []struct {
		name     string
		served   []Entry
		chapters []chapter
		want     []Entry
		review   []chapter
	}{
		{"both edges near", []Entry{ai(311, 431)}, []chapter{{0, 307, "Вступление"}, {307, 437, "Реклама"}}, []Entry{moved(307, 437)}, nil},
		{"title not read", []Entry{ai(239, 334)}, []chapter{{236, 338, "Обзор геймпада"}}, []Entry{moved(236, 338)}, nil},
		{"rounded inward", []Entry{ai(100, 160)}, []chapter{{95.4, 158.6, "x"}}, []Entry{moved(96, 158)}, nil},
		{"overlaps another served entry", []Entry{ai(100, 150), ai(155, 200)}, []chapter{{95, 158, "x"}}, []Entry{ai(100, 150), ai(155, 200)}, nil},
		{"shorter than the length rule", []Entry{ai(50, 58)}, []chapter{{52, 55, "x"}}, []Entry{ai(50, 58)}, nil},
		{"smallest total distance", []Entry{ai(100, 160)}, []chapter{{104, 169, "a"}, {95, 158, "b"}}, []Entry{moved(95, 158)}, nil},
		{"chapter far past the ad", []Entry{ai(1006, 1076)}, []chapter{{1008, 1505, "Мегабожественная интеграция"}}, []Entry{ai(1006, 1076)},
			[]chapter{{1008, 1505, "Мегабожественная интеграция"}}},
		{"topic chapter ending with the ad", []Entry{ai(2108, 2127)}, []chapter{{1909, 2127, "Манты"}}, []Entry{ai(2108, 2127)}, nil},
		{"no edge near", []Entry{ai(500, 560)}, []chapter{{400, 700, "Реклама"}}, []Entry{ai(500, 560)}, nil},
		{"no overlap", []Entry{ai(500, 560)}, []chapter{{560, 600, "Реклама"}}, []Entry{ai(500, 560)}, nil},
		{"two ad chapters, nearer one", []Entry{ai(1341, 1434)}, []chapter{{1337, 1378, "Реклама"}, {1378, 1440, "Промокод"}},
			[]Entry{ai(1341, 1434)}, []chapter{{1378, 1440, "Промокод"}}},
		{"no chapters", []Entry{ai(10, 40)}, nil, []Entry{ai(10, 40)}, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, matches := applyChapters(c.served, c.chapters, 10, 5)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("served %+v, want %+v", got, c.want)
			}
			var review []chapter
			for _, m := range matches {
				review = append(review, m.chapter)
			}
			if !reflect.DeepEqual(review, c.review) {
				t.Fatalf("review %+v, want %+v", review, c.review)
			}
		})
	}
	if got, _ := applyChapters([]Entry{}, []chapter{{0, 60, "Реклама"}}, 10, 5); got == nil {
		t.Fatal("nothing served came back nil: data would be JSON null")
	}
	served := []Entry{ai(311, 431)}
	applyChapters(served, []chapter{{307, 437, "x"}}, 10, 5)
	if served[0].Source != "ai" {
		t.Fatal("the caller's slice was changed")
	}
}

func TestClock(t *testing.T) {
	for in, want := range map[float64]string{0: "0:00", 1337: "22:17", 1505.4: "25:05", 3725: "1:02:05"} {
		if got := clock(in); got != want {
			t.Fatalf("clock(%v) = %q, want %q", in, got, want)
		}
	}
}

// finish with the switch on serves the both-edges chapter's bounds and sends the
// one-edge ad chapter's entry to review after the AI row; off, it publishes the AI bounds.
func TestFinishAppliesChaptersOnlyWhenSwitchedOn(t *testing.T) {
	chapters := []chapter{{8, 42, "Обзор"}, {55, 200, "Реклама"}}
	for _, on := range []bool{false, true} {
		db, mock, err := sqlmock.New()
		if err != nil {
			t.Fatal(err)
		}
		r := &detectRun{db: db, categories: map[string]int{"sponsor": 2, "self_promotion": 3}, prv: testPrv}
		r.cfg.MinSegmentSeconds, r.cfg.ChapterEdge, r.cfg.ChaptersEnabled = 5, 10, on

		data := `[{"category_id":2,"start":10,"end":40,"confidence":"high","source":"ai"},{"category_id":2,"start":60,"end":90,"confidence":"high","source":"ai"}]`
		if on {
			data = `[{"category_id":2,"start":8,"end":42,"confidence":"high","source":"chapter"},{"category_id":2,"start":60,"end":90,"confidence":"high","source":"ai"}]`
		}
		expectPublishBegin(mock)
		mock.ExpectQuery(regexp.QuoteMeta("SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE")).
			WillReturnRows(sqlmock.NewRows([]string{"status"}).AddRow("detecting"))
		mock.ExpectExec("UPDATE prv_ai_runs SET raw_output").WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectExec(regexp.QuoteMeta("SELECT 1 FROM video_calculateds WHERE video_id = $1 FOR UPDATE")).WithArgs(7).WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectQuery(`(?s)DISTINCT ON .*FROM votes`).WillReturnRows(sqlmock.NewRows([]string{"category_id", "start", "end", "rating"}))
		mock.ExpectExec("INSERT INTO prv_ai_video_calculateds").WithArgs(7, "-1_456000001", int64(11), []byte(data), []byte(`[]`)).
			WillReturnResult(sqlmock.NewResult(0, 1))
		if on {
			mock.ExpectQuery("SELECT b.batch FROM prv_review_batches").WillReturnRows(sqlmock.NewRows([]string{"batch"}))
			mock.ExpectQuery("SELECT COUNT\\(DISTINCT batch\\)").WillReturnRows(sqlmock.NewRows([]string{"n"}).AddRow(0))
			mock.ExpectExec("INSERT INTO prv_review_batches").WithArgs(sqlmock.AnyArg(), "important").WillReturnResult(sqlmock.NewResult(0, 1))
			mock.ExpectQuery("COALESCE\\(MAX\\(position\\), 0\\)").WillReturnRows(sqlmock.NewRows([]string{"max"}).AddRow(0))
			mock.ExpectExec("INSERT INTO prv_review_items").
				WithArgs(sqlmock.AnyArg(), sqlmock.AnyArg(), "T1", 1, "-1_456000001", 60, 90, "sponsor", "d",
					"https://example.invalid/video-1_456000001?t=58s",
					[]byte(`["chapter: «Реклама» 0:55–3:20 (start 5 s off, end 110 s off)","entry: sponsor high, 30 s"]`), 7).
				WillReturnResult(sqlmock.NewResult(1, 1))
		}
		mock.ExpectExec("UPDATE prv_ai_videos SET status = 'published'").WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectCommit()

		res := segs(seg("sponsor", 1, 1), seg("sponsor", 3, 3))
		if err := r.finish("-1_456000001", 11, 7, confirmCues, chapters, r.price, res, nil, nil); err != nil {
			t.Fatalf("on=%v: %v", on, err)
		}
		if err := mock.ExpectationsWereMet(); err != nil {
			t.Fatalf("on=%v: %v", on, err)
		}
		db.Close()
	}
}

func TestStartRunStoresTheChapters(t *testing.T) {
	for _, c := range []struct {
		chapters []chapter
		want     any
	}{
		{[]chapter{{307, 437, "Реклама"}}, []byte(`[{"start":307,"end":437,"title":"Реклама"}]`)},
		{[]chapter{}, []byte(`[]`)},
		{nil, nil}, // the info did not parse: unknown, not none
	} {
		r, mock, _ := batchRun(t)
		p := readyVideo("-1_456000001")
		p.chapters = c.chapters
		mock.ExpectBegin()
		mock.ExpectQuery("INSERT INTO prv_ai_runs").WithArgs("-1_456000001", 7, sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(),
			sqlmock.AnyArg(), sqlmock.AnyArg(), sqlmock.AnyArg(), c.want).WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(11))
		mock.ExpectExec(regexp.QuoteMeta("SET status = 'detecting', batch_id = NULL")).WillReturnResult(sqlmock.NewResult(0, 1))
		mock.ExpectCommit()
		if _, err := r.startRun(p); err != nil {
			t.Fatal(err)
		}
	}
}
