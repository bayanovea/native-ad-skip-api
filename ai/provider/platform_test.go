package provider

import (
	"testing"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

func TestPrvPickTrackShapes(t *testing.T) {
	manifest := ytdlp.Track{Ext: "vtt", URL: "u1", ManifestURL: "m1"}
	cases := []struct {
		name string
		subs []ytdlp.Track
		auto map[string][]ytdlp.Track
		want transcript.TrackType
		ok   bool
	}{
		{"auto label", []ytdlp.Track{manifest, {Ext: "Ru AUTO", URL: "u2"}}, nil, transcript.TrackAuto, true},
		{"plain label is not evidence", []ytdlp.Track{manifest, {Ext: "vtt", URL: "u2"}}, nil, transcript.TrackUnknown, true},
		{"manifest only", []ytdlp.Track{manifest}, nil, transcript.TrackUnknown, true},
		{"automatic_captions", nil, map[string][]ytdlp.Track{"ru": {{Ext: "vtt"}}}, transcript.TrackAuto, true},
		{"none", nil, nil, transcript.TrackNone, false},
	}
	for _, c := range cases {
		info := &ytdlp.Info{Subtitles: map[string][]ytdlp.Track{"ru": c.subs}, AutomaticCaptions: c.auto}
		_, typ, _, ok := prv{}.PickTrack(info, "ru")
		if typ != c.want || ok != c.ok {
			t.Errorf("%s: got %s/%v want %s/%v", c.name, typ, ok, c.want, c.ok)
		}
	}
}

func TestRegistry(t *testing.T) {
	p, err := Lookup("prv")
	if err != nil || p.Name() != "prv" {
		t.Fatalf("prv not registered: %v", err)
	}
	if p.VideoURL("-1_2") != "https://example.invalid/video-1_2" {
		t.Errorf("url: %s", p.VideoURL("-1_2"))
	}
	if _, err := Lookup("nope"); err == nil {
		t.Error("unknown provider must fail")
	}
}

func TestPrvLinkAt(t *testing.T) {
	v := prv{}
	for _, c := range []struct {
		sec  int
		want string
	}{
		{1992, "https://example.invalid/video-1_456000001?t=33m12s"},
		{3843, "https://example.invalid/video-1_456000001?t=1h4m3s"},
		{7, "https://example.invalid/video-1_456000001?t=7s"},
		{-2, "https://example.invalid/video-1_456000001?t=0s"},
	} {
		if got := v.LinkAt("-1_456000001", c.sec); got != c.want {
			t.Errorf("LinkAt(%d) = %s, want %s", c.sec, got, c.want)
		}
	}
}
