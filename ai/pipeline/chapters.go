package pipeline

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"time"

	"odedohbest/video-calculate/ai/review"
	"odedohbest/video-calculate/ai/vtt"
)

// chapter is one of the video's own chapters (the timecodes of its description),
// as yt-dlp's info reports them; stored as prv_ai_runs.chapters.
type chapter struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Title string  `json:"title"`
}

const sourceChapter = "chapter"

// adTitle only decides whether an assessor looks at a one-edge match, never what
// is served: it also hits news about ads. The dashboard's "ad chapters with no
// entry" panel repeats it (tagged chapters.go adTitle).
var adTitle = regexp.MustCompile(`(?i)реклам|интеграц|спонсор|партн[её]р|промокод|скидк|erid|при поддержке|купон|розыгрыш`)

// parseChapters reads the chapters from yt-dlp's raw info JSON (ai/ytdlp is an
// eval copy, so its Info does not carry them); nil when the JSON does not parse.
func parseChapters(nativeID string, raw []byte) []chapter {
	var info struct {
		Chapters []struct {
			Start float64 `json:"start_time"`
			End   float64 `json:"end_time"`
			Title string  `json:"title"`
		} `json:"chapters"`
	}
	if err := json.Unmarshal(raw, &info); err != nil {
		log.Printf("ai detect: %s chapters: %v", nativeID, err)
		return nil
	}
	out := make([]chapter, len(info.Chapters))
	for i, c := range info.Chapters {
		out[i] = chapter(c)
	}
	return out
}

// chapterMatch is a served entry an ad-titled chapter agrees with at one edge only.
type chapterMatch struct {
	entry   Entry
	chapter chapter
}

// applyChapters serves an entry at the bounds of a chapter that agrees with both
// its edges within edge seconds (title not read: the models already called it an
// ad), unless those bounds break the length rule or overlap another served entry;
// an entry an ad-titled chapter agrees with at one edge only keeps its bounds and
// is returned for review (owner, 2026-11-02).
func applyChapters(served []Entry, chapters []chapter, edge, minSeconds int) ([]Entry, []chapterMatch) {
	// Not append([]Entry(nil), …): an empty served list must stay [] in data, never JSON null.
	out := append([]Entry{}, served...)
	var toReview []chapterMatch
	near := float64(edge)
	for i, e := range out {
		both, one := -1, -1
		bestBoth, bestOne := math.Inf(1), math.Inf(1)
		for j, c := range chapters {
			if c.Start >= float64(e.End) || c.End <= float64(e.Start) {
				continue
			}
			ds, de := math.Abs(c.Start-float64(e.Start)), math.Abs(c.End-float64(e.End))
			switch {
			case ds <= near && de <= near:
				if ds+de < bestBoth {
					both, bestBoth = j, ds+de
				}
			case (ds <= near || de <= near) && adTitle.MatchString(c.Title):
				if ds+de < bestOne {
					one, bestOne = j, ds+de
				}
			}
		}
		if both >= 0 {
			start, end := int(math.Ceil(chapters[both].Start)), int(math.Floor(chapters[both].End))
			if end-start >= minSeconds && !overlapsOther(out, i, start, end) {
				out[i].Start, out[i].End, out[i].Source = start, end, sourceChapter
				continue
			}
		}
		if one >= 0 {
			toReview = append(toReview, chapterMatch{entry: e, chapter: chapters[one]})
		}
	}
	return out, toReview
}

func overlapsOther(entries []Entry, skip, start, end int) bool {
	for i, e := range entries {
		if i != skip && e.Start < end && e.End > start {
			return true
		}
	}
	return false
}

// sendChapterItems puts one T item per match into today's ai-chapter sheet, in
// finish's transaction after the AI row (lock order as record's).
func (r *detectRun) sendChapterItems(tx *sql.Tx, matches []chapterMatch, videoID int, nativeID string, cues []vtt.Cue, now time.Time) error {
	if len(matches) == 0 {
		return nil
	}
	names := r.categoryNames()
	items := make([]review.Item, len(matches))
	for i, m := range matches {
		e, c := m.entry, m.chapter
		items[i] = review.Item{NativeID: nativeID, VideoID: videoID, Start: e.Start, End: e.End, Proposed: names[e.CategoryID],
			Cues: review.CueText(cues, float64(e.Start), float64(e.End), "\n"), Link: r.prv.LinkAt(nativeID, e.Start-2),
			FlaggedBy: []string{fmt.Sprintf("chapter: «%s» %s–%s (start %.0f s off, end %.0f s off)",
				c.Title, clock(c.Start), clock(c.End), math.Abs(c.Start-float64(e.Start)), math.Abs(c.End-float64(e.End))),
				fmt.Sprintf("entry: %s %s, %d s", names[e.CategoryID], e.Confidence, e.End-e.Start)}}
	}
	// important, as the second opinion's: viewers get the AI bounds meanwhile, a timing question.
	if _, err := review.Add(tx, "ai-chapter-"+now.UTC().Format("2006-01-02"), "T", "important", items); err != nil {
		return fmt.Errorf("chapter items: %w", err)
	}
	return nil
}

// clock is lib/review-sheet.js formatPlayerTime: m:ss, h:mm:ss from an hour.
func clock(seconds float64) string {
	s := int(math.Round(seconds))
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}
