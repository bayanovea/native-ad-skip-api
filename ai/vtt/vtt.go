// Package vtt parses WebVTT subtitle files and collapses "rolling" captions
// (each phrase repeated across consecutive cues with word-level timing tags)
// into one plain cue per phrase.
package vtt

import (
	"bufio"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Cue is one subtitle phrase with its time span in seconds.
type Cue struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
	// Words are the tokens of Text with their start times, from the inline
	// <hh:mm:ss.mmm> tags of auto captions; nil for a cue without such tags.
	Words []Word `json:"words,omitempty"`
}

// Word is one whitespace-separated token of a cue's text and its start time.
type Word struct {
	T    float64 `json:"t"`
	Text string  `json:"text"`
}

var (
	timingRe = regexp.MustCompile(`^(\d+):(\d{2}):(\d{2}\.\d+)\s+-->\s+(\d+):(\d{2}):(\d{2}\.\d+)`)
	tagRe    = regexp.MustCompile(`<[^>]*>`)
	stampRe  = regexp.MustCompile(`<(?:(\d+):)?(\d{2}):(\d{2}\.\d+)>`)
	spaceRe  = regexp.MustCompile(`\s+`)
)

// minCueLen drops the 10 ms "hold" cues that rolling captions emit between phrases.
const minCueLen = 0.05

// Parse reads raw VTT and returns every cue verbatim (tags stripped, lines joined),
// without any collapsing. Cues shorter than minCueLen are dropped. A cue with
// timestamp tags gets Words: a word takes the time of the tag before it, the
// text before a line's first tag takes the cue start.
func Parse(r io.Reader) ([]Cue, error) {
	var (
		cues  []Cue
		cur   *Cue
		lines []string
	)
	flush := func() {
		if cur != nil {
			cur.Text = cleanText(strings.Join(lines, " "))
			cur.Words = parseWords(lines, cur.Start)
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
		out = append(out, Cue{Start: c.Start, End: c.End, Text: text, Words: tailWords(c.Words, text)})
	}
	return out
}

// tailWords keeps the words of a collapsed cue's tail: the last as many words
// as the tail has tokens. The first kept word takes the tail's first token, in
// case the dropped prefix ended inside a token.
func tailWords(words []Word, tail string) []Word {
	toks := strings.Fields(tail)
	if len(words) < len(toks) || len(toks) == 0 {
		return nil
	}
	out := append([]Word(nil), words[len(words)-len(toks):]...)
	out[0].Text = toks[0]
	return out
}

// parseWords splits a cue's lines into words timed by the timestamp tags, or
// returns nil when no line has one. A word takes the time of the segment its
// first byte comes from; the words are strings.Fields of Cue.Text, which
// Collapse relies on.
func parseWords(lines []string, start float64) []Word {
	if !stampRe.MatchString(strings.Join(lines, "")) {
		return nil
	}
	var words []Word
	for _, line := range lines {
		var text strings.Builder
		var times []float64 // time of each byte of text
		t, pos := start, 0
		appendSeg := func(seg string) {
			seg = tagRe.ReplaceAllString(seg, "")
			text.WriteString(seg)
			for range len(seg) {
				times = append(times, t)
			}
		}
		for _, m := range stampRe.FindAllStringSubmatchIndex(line, -1) {
			appendSeg(line[pos:m[0]])
			h := "0"
			if m[2] >= 0 {
				h = line[m[2]:m[3]]
			}
			if ts, err := toSeconds(h, line[m[4]:m[5]], line[m[6]:m[7]]); err == nil {
				t = ts
			}
			pos = m[1]
		}
		appendSeg(line[pos:])
		str, from := text.String(), -1
		for i, r := range str + " " {
			switch {
			case !unicode.IsSpace(r) && from < 0:
				from = i
			case unicode.IsSpace(r) && from >= 0:
				words = append(words, Word{T: times[from], Text: str[from:i]})
				from = -1
			}
		}
	}
	return words
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
