package detector

import (
	"strings"
	"testing"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/vtt"
)

var cues = []vtt.Cue{
	{Start: 0, End: 2.4, Text: "всем привет"},
	{Start: 2.4, End: 5.1, Text: "сегодня у нас"},
	{Start: 9.0, End: 12.0, Text: "спонсор выпуска, промокод"},
	{Start: 12.0, End: 15.5, Text: "ссылка в описании"},
	{Start: 20.0, End: 22.0, Text: "а теперь к теме"},
}

func TestNewRequestRendersNumberedCues(t *testing.T) {
	p := Prompt{Version: "v1", Text: "SYSTEM"}
	req := NewRequest(p, transcript.Meta{Lang: "ru", Duration: 22.4}, cues)
	if req.System != "SYSTEM" || req.Schema != Schema {
		t.Fatal("system or schema not passed through")
	}
	want := []string{`<transcript lang="ru" duration="22">`, "[2] 9.0-12.0: спонсор выпуска, промокод", "</transcript>"}
	for _, w := range want {
		if !strings.Contains(req.User, w) {
			t.Errorf("user message lacks %q:\n%s", w, req.User)
		}
	}
}

func TestValidate(t *testing.T) {
	ok := Output{Segments: []Segment{{Category: "sponsor", FirstCue: 2, LastCue: 3, Confidence: "high", Quote: "спонсор выпуска"}}}
	if err := Validate(cues, ok); err != nil {
		t.Fatalf("valid output rejected: %v", err)
	}
	if err := Validate(cues, Output{}); err != nil {
		t.Fatalf("empty output rejected: %v", err)
	}
	bad := map[string]Output{
		"index out of range": {Segments: []Segment{{Category: "sponsor", FirstCue: 2, LastCue: 5}}},
		"reversed":           {Segments: []Segment{{Category: "sponsor", FirstCue: 3, LastCue: 2}}},
		"overlap":            {Segments: []Segment{{Category: "sponsor", FirstCue: 1, LastCue: 2}, {Category: "self_promotion", FirstCue: 2, LastCue: 3}}},
		"unknown category":   {Segments: []Segment{{Category: "intro", FirstCue: 0, LastCue: 1}}},
	}
	for name, out := range bad {
		if err := Validate(cues, out); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// adjacent segments are fine: sponsor then self_promotion back to back
	adj := Output{Segments: []Segment{{Category: "self_promotion", FirstCue: 3, LastCue: 3}, {Category: "sponsor", FirstCue: 2, LastCue: 2}}}
	if err := Validate(cues, adj); err != nil {
		t.Errorf("adjacent segments rejected: %v", err)
	}
}

func TestResolveAndQuote(t *testing.T) {
	out := Output{Segments: []Segment{{Category: "sponsor", FirstCue: 2, LastCue: 3, Quote: "Спонсор выпуска"}}}
	preds := Resolve(cues, out)
	if len(preds) != 1 || preds[0].Start != 9.0 || preds[0].End != 15.5 {
		t.Fatalf("resolve: %+v", preds)
	}
	if !QuoteMatches(cues, out.Segments[0]) {
		t.Error("case-insensitive prefix quote should match")
	}
	if QuoteMatches(cues, Segment{FirstCue: 2, Quote: "ссылка"}) {
		t.Error("quote from another cue should not match")
	}
}

func TestParseOutputAndCost(t *testing.T) {
	out, err := ParseOutput(`{"segments":[{"category":"sponsor","first_cue":2,"last_cue":3,"confidence":"low","quote":"x"}]}`)
	if err != nil || len(out.Segments) != 1 {
		t.Fatalf("parse: %v %+v", err, out)
	}
	if _, err := ParseOutput(`{"segments":[],"extra":1}`); err == nil {
		t.Error("unknown field accepted")
	}
	c := Prices["claude-opus-5-5"].Cost(Usage{InputTokens: 1_000_000, OutputTokens: 100_000})
	if c != 6 {
		t.Errorf("cost: want 6, got %v", c)
	}
}

func TestFormatNoTimesDropsTimestamps(t *testing.T) {
	cues := []vtt.Cue{{Start: 1.5, End: 3, Text: "hello"}, {Start: 4, End: 5, Text: "world"}}
	req := NewRequestFormat(Prompt{Text: "p"}, transcript.Meta{Lang: "ru", Duration: 5}, cues, Format{NoTimes: true})
	if strings.Contains(req.User, "1.5") || !strings.Contains(req.User, "[1] world\n") {
		t.Fatalf("unexpected user message:\n%s", req.User)
	}
}

func TestFormatApplyMergesIntoWindows(t *testing.T) {
	cues := []vtt.Cue{
		{Start: 0, End: 2, Text: "a"}, {Start: 2, End: 4, Text: "b"}, {Start: 4, End: 6, Text: "c"},
		{Start: 10, End: 11, Text: "d"}, {Start: 11, End: 12, Text: "e"},
	}
	got := Format{WindowSeconds: 5}.Apply(cues)
	// window 1 grows until it spans >= 5 s (a b c = 0..6); window 2 is the rest (d e = 10..12)
	if len(got) != 2 || got[0].Start != 0 || got[0].End != 6 || got[0].Text != "a b c" || got[1].Start != 10 || got[1].End != 12 {
		t.Fatalf("got %+v", got)
	}
	if same := (Format{}).Apply(cues); len(same) != len(cues) {
		t.Fatalf("zero Format must not change cues")
	}
}

func TestOpenAICost(t *testing.T) {
	c := Prices["gpt-5"].Cost(Usage{InputTokens: 1_000_000, OutputTokens: 100_000, CacheReadTokens: 1_000_000})
	if want := 1.25 + 1.0 + 0.125; c < want-1e-9 || c > want+1e-9 {
		t.Fatalf("gpt-5 cost %v, want %v", c, want)
	}
}
