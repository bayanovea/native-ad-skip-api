package judge

import (
	"strings"
	"testing"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/vtt"
)

func TestParseOutput(t *testing.T) {
	for _, c := range []struct {
		raw, err string
	}{
		{`{"decision":"withdraw","reason":"r","segments":[{"index":0,"keep":false},{"index":1,"keep":true}]}`, ""},
		{`{"decision":"ok","reason":"r","segments":[]}`, ""},
		{`not json`, "parse"},
		{`{"decision":"ok","reason":"r","segments":[],"extra":1}`, "parse"},
		{`stop_reason max_tokens: {"decision":"ok"`, "parse"},
		{`{"decision":"maybe","reason":"r","segments":[]}`, "unknown decision"},
		{`{"decision":"ok","reason":" ","segments":[]}`, "empty reason"},
		{`{"decision":"review","reason":"r","segments":[{"index":2,"keep":true}]}`, "outside 0..1"},
		{`{"decision":"review","reason":"r","segments":[{"index":0,"keep":true},{"index":0,"keep":false}]}`, "twice"},
	} {
		_, err := parseOutput(c.raw, 2)
		if (c.err == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.err)) {
			t.Errorf("%s: got %v, want %q", c.raw, err, c.err)
		}
	}
}

func TestDisagreementWindows(t *testing.T) {
	entries := []Entry{{CategoryID: 2, Start: 30, End: 70}, {CategoryID: 2, Start: 150, End: 160}, {CategoryID: 2, Start: 400, End: 420}}
	humans := []humanNote{
		{humanInterval{2, 100, 120, 0}, true},  // overlaps the first two windows: one window
		{humanInterval{2, 405, 418, 0}, false}, // agrees: no window of its own
		{humanInterval{2, 900, 930, 0}, true},
	}
	got := disagreementWindows(entries, humans)
	want := []window{{0, 220}, {340, 480}, {840, 990}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestRenderRequest(t *testing.T) {
	cues := []vtt.Cue{
		{Start: 5, End: 9, Text: "привет"},
		{Start: 31, End: 35, Text: "спонсор выпуска"},
		{Start: 36, End: 40, Text: "переходите по ссылке"},
		{Start: 300, End: 304, Text: "далеко от всего"},
		{Start: 500, End: 504, Text: "подписывайтесь"},
	}
	s := Signals{Counters: Counters{Undo: 5, HumanMarkups: 1, ConflictingMarkups: 1}, ViewsMax: new(int64), Requests: 12, AgeH: 30}
	*s.ViewsMax = 25000
	s.humans = []humanNote{{humanInterval{3, 495, 510, 4}, true}}
	req := renderRequest(detector.Prompt{Text: "PROMPT"}, testVideo, s, testCategories, cues)
	if req.System != "PROMPT" || req.Key != "-1_456000001" || req.Schema != llmSchema {
		t.Fatalf("got %+v", req)
	}
	for _, want := range []string{
		`<video duration="600" published_hours_ago="30" requests="12" views="25000">`,
		"[0] sponsor 30-70 s: спонсор выпуска переходите по ссылке\n",
		"undo=5 (0.20 per 1k views)\n",
		"self_promotion 495-510 s, author rating 4, disagrees with the AI\n",
		"<transcript from=\"0\" to=\"130\">\n5.0-9.0: привет\n31.0-35.0: спонсор выпуска\n36.0-40.0: переходите по ссылке\n</transcript>\n",
		"<transcript from=\"435\" to=\"570\">\n500.0-504.0: подписывайтесь\n</transcript>\n",
	} {
		if !strings.Contains(req.User, want) {
			t.Errorf("missing %q in\n%s", want, req.User)
		}
	}
	if strings.Contains(req.User, "далеко от всего") {
		t.Error("a cue outside every window is not sent")
	}
}
