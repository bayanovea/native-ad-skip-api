package provider

import (
	"strings"
	"testing"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

const testConfig = `{"providers": [{
	"name": "main",
	"video_url": "https://example.invalid/video/{id}",
	"link_at": "https://example.invalid/watch/{id}?t={t}",
	"channel_url": "https://example.invalid/channel/{channel}/videos"
}]}`

func init() {
	if err := Load(strings.NewReader(testConfig)); err != nil {
		panic(err)
	}
}

func TestPickTrackShapes(t *testing.T) {
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
		_, typ, _, ok := platform{}.PickTrack(info, "ru")
		if typ != c.want || ok != c.ok {
			t.Errorf("%s: got %s/%v want %s/%v", c.name, typ, ok, c.want, c.ok)
		}
	}
}

func TestRegistry(t *testing.T) {
	p, err := Lookup("main")
	if err != nil || p.Name() != "main" {
		t.Fatalf("main not registered: %v", err)
	}
	if p.VideoURL("c1_2") != "https://example.invalid/video/c1_2" {
		t.Errorf("url: %s", p.VideoURL("c1_2"))
	}
	if p.ChannelURL("c1") != "https://example.invalid/channel/c1/videos" {
		t.Errorf("channel url: %s", p.ChannelURL("c1"))
	}
	if _, err := Lookup("nope"); err == nil {
		t.Error("unknown provider must fail")
	}
	if p, err := Resolve(""); err != nil || p.Name() != "main" {
		t.Errorf("Resolve(\"\") with one provider: %v, %v", p, err)
	}
}

func TestLoadRejectsBadConfig(t *testing.T) {
	for name, cfg := range map[string]string{
		"duplicate":  `{"providers":[{"name":"main","video_url":"x","link_at":"y"}]}`,
		"no name":    `{"providers":[{"video_url":"x","link_at":"y"}]}`,
		"no link_at": `{"providers":[{"name":"other","video_url":"x"}]}`,
		"not json":   `providers:`,
	} {
		if err := Load(strings.NewReader(cfg)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
	if _, err := Lookup("other"); err == nil {
		t.Error("a rejected config must register nothing")
	}
	if got := (platform{Def{Name: "x", VideoURL: "v", LinkAt: "l"}}).ChannelURL("c"); got != "" {
		t.Errorf("ChannelURL without template = %q, want empty", got)
	}
}

func TestLinkAt(t *testing.T) {
	v, _ := Lookup("main")
	for _, c := range []struct {
		sec  int
		want string
	}{
		{1992, "https://example.invalid/watch/c1_1001?t=33m12s"},
		{3843, "https://example.invalid/watch/c1_1001?t=1h4m3s"},
		{7, "https://example.invalid/watch/c1_1001?t=7s"},
		{-2, "https://example.invalid/watch/c1_1001?t=0s"},
	} {
		if got := v.LinkAt("c1_1001", c.sec); got != c.want {
			t.Errorf("LinkAt(%d) = %s, want %s", c.sec, got, c.want)
		}
	}
}
