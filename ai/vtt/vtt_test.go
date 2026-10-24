package vtt

import (
	"encoding/json"
	"reflect"
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

func TestParseWordTimes(t *testing.T) {
	cues, err := Parse(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	// Text before a line's first tag takes the cue start, each tagged word its tag.
	want := []Word{{46.86, "всем"}, {47.07, "привет,"}, {47.25, "всем,"}}
	if !reflect.DeepEqual(cues[2].Words, want) {
		t.Errorf("words: %+v", cues[2].Words)
	}
	// Rolling cue: the untagged repeat line and the new line both get words.
	want = []Word{{48.28, "всем"}, {48.28, "привет,"}, {48.28, "всем,"}, {48.28, "приветики,"}, {50.43, "здравствуйте,"}}
	if !reflect.DeepEqual(cues[3].Words, want) {
		t.Errorf("rolling words: %+v", cues[3].Words)
	}
	for _, c := range cues {
		if c.Words != nil && len(c.Words) != len(strings.Fields(c.Text)) {
			t.Errorf("cue %q: %d words", c.Text, len(c.Words))
		}
	}
}

func TestParseNoTagsNoWords(t *testing.T) {
	cues, _ := Parse(strings.NewReader(sample))
	for _, i := range []int{0, 1, 4} {
		if cues[i].Words != nil {
			t.Errorf("cue %d %q: words %+v", i, cues[i].Text, cues[i].Words)
		}
	}
	b, _ := json.Marshal(cues[4])
	if strings.Contains(string(b), "words") {
		t.Errorf("words in JSON of an untagged cue: %s", b)
	}
}

func TestCollapseKeepsTailWords(t *testing.T) {
	cues, _ := Parse(strings.NewReader(sample))
	got := Collapse(cues)
	if want := []Word{{46.86, "всем"}, {47.07, "привет,"}, {47.25, "всем,"}}; !reflect.DeepEqual(got[1].Words, want) {
		t.Errorf("first phrase words: %+v", got[1].Words)
	}
	if want := []Word{{48.28, "приветики,"}, {50.43, "здравствуйте,"}}; !reflect.DeepEqual(got[2].Words, want) {
		t.Errorf("tail words: %+v", got[2].Words)
	}
	if got[0].Words != nil || got[3].Words != nil {
		t.Errorf("untagged cues got words: %+v / %+v", got[0].Words, got[3].Words)
	}
}

func TestParseWordsGluedTagAndShortStamp(t *testing.T) {
	const in = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nпо<00:01.500><c>ка</c><00:02.000><c> до</c>\n"
	cues, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	if cues[0].Text != "пока до" {
		t.Fatalf("text %q", cues[0].Text)
	}
	if want := []Word{{1, "пока"}, {2, "до"}}; !reflect.DeepEqual(cues[0].Words, want) {
		t.Errorf("words: %+v", cues[0].Words)
	}
}
