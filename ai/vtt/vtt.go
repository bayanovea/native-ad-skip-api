// Package vtt parses WebVTT subtitle files and collapses "rolling" captions
// (yt/prv style, where each phrase is repeated across consecutive cues
// with word-level timing tags) into one plain cue per phrase.
package vtt

import (
	"bufio"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// Cue is one subtitle phrase with its time span in seconds.
type Cue struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

var (
	timingRe = regexp.MustCompile(`^(\d+):(\d{2}):(\d{2}\.\d+)\s+-->\s+(\d+):(\d{2}):(\d{2}\.\d+)`)
	tagRe    = regexp.MustCompile(`<[^>]*>`)
	spaceRe  = regexp.MustCompile(`\s+`)
)

// minCueLen drops the 10 ms "hold" cues that rolling captions emit between phrases.
const minCueLen = 0.05

// Parse reads raw VTT and returns every cue verbatim (tags stripped, lines joined),
// without any collapsing. Cues shorter than minCueLen are dropped.
func Parse(r io.Reader) ([]Cue, error) {
	var (
		cues  []Cue
		cur   *Cue
		lines []string
	)
	flush := func() {
		if cur != nil {
			cur.Text = cleanText(strings.Join(lines, " "))
			if cur.End-cur.Start >= minCueLen && cur.Text != "" {
				cues = append(cues, *cur)
			}
		}
		cur, lines = nil, nil
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if m := timingRe.FindStringSubmatch(line); m != nil {
			flush()
			start, err1 := toSeconds(m[1], m[2], m[3])
			end, err2 := toSeconds(m[4], m[5], m[6])
			if err1 != nil || err2 != nil {
				return nil, fmt.Errorf("vtt: bad timing line %q", line)
			}
			cur = &Cue{Start: start, End: end}
			continue
		}
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if cur != nil {
			lines = append(lines, line)
		}
	}
	flush()
	return cues, sc.Err()
}

// Collapse removes the rolling-caption redundancy: when a cue's text starts with
// the previous kept cue's text, only the new tail is kept; exact repeats are dropped.
func Collapse(cues []Cue) []Cue {
	out := make([]Cue, 0, len(cues)/2)
	for _, c := range cues {
		text := c.Text
		if n := len(out); n > 0 {
			prev := out[n-1].Text
			if strings.HasPrefix(text, prev) {
				text = strings.TrimSpace(text[len(prev):])
			}
			if text == "" || text == prev {
				continue
			}
		}
		out = append(out, Cue{Start: c.Start, End: c.End, Text: text})
	}
	return out
}

// Words counts whitespace-separated tokens across cues.
func Words(cues []Cue) int {
	n := 0
	for _, c := range cues {
		n += len(strings.Fields(c.Text))
	}
	return n
}

func cleanText(s string) string {
	s = tagRe.ReplaceAllString(s, "")
	s = spaceRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

func toSeconds(h, m, s string) (float64, error) {
	hh, err := strconv.Atoi(h)
	if err != nil {
		return 0, err
	}
	mm, err := strconv.Atoi(m)
	if err != nil {
		return 0, err
	}
	ss, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, err
	}
	return float64(hh)*3600 + float64(mm)*60 + ss, nil
}
