package vtt

import (
	"strings"
	"testing"
)

const sample = `WEBVTT
Language: ru

00:00:08.740 --> 00:00:08.880
Нет,

00:00:08.880 --> 00:00:10.880
Нет, 
 

00:00:46.860 --> 00:00:48.270
всем<00:00:47.070><c> привет,</c><00:00:47.250><c> всем,</c>

00:00:48.270 --> 00:00:48.280
всем привет, всем, 
 

00:00:48.280 --> 00:00:53.420
всем привет, всем, 
приветики,<00:00:50.430><c> здравствуйте,</c>

00:00:53.420 --> 00:00:53.430
приветики, здравствуйте, 
 

01:02:03.000 --> 01:02:04.500
последняя фраза
`

func TestParseStripsTagsAndHoldCues(t *testing.T) {
	cues, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	// 7 blocks, 2 are 10 ms holds -> 5.
	if len(cues) != 5 {
		t.Fatalf("got %d cues: %+v", len(cues), cues)
	}
	if cues[2].Text != "всем привет, всем," {
		t.Errorf("tags not stripped: %q", cues[2].Text)
	}
	if cues[4].Start != 3723 || cues[4].End != 3724.5 {
		t.Errorf("hour timing wrong: %+v", cues[4])
	}
}

func TestCollapseKeepsOnlyNewTail(t *testing.T) {
	cues, _ := Parse(strings.NewReader(sample))
	got := Collapse(cues)
	want := []string{"Нет,", "всем привет, всем,", "приветики, здравствуйте,", "последняя фраза"}
	if len(got) != len(want) {
		t.Fatalf("got %d cues: %+v", len(got), got)
	}
	for i := range want {
		if got[i].Text != want[i] {
			t.Errorf("cue %d: got %q want %q", i, got[i].Text, want[i])
		}
	}
	if got[2].Start != 48.28 {
		t.Errorf("tail cue should keep its own start, got %v", got[2].Start)
	}
	if Words(got) != 8 {
		t.Errorf("words = %d, want 8", Words(got))
	}
}
