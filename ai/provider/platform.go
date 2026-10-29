package provider

import (
	"fmt"
	"strings"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

// platform is a Def with the URL templates expanded.
type platform struct{ def Def }

func (p platform) Name() string                    { return p.def.Name }
func (p platform) VideoURL(nativeID string) string { return expand(p.def.VideoURL, "{id}", nativeID) }

// LinkAt renders the start offset as 1h2m3s (hours and minutes only when non-zero).
func (p platform) LinkAt(nativeID string, seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	h, m, s := seconds/3600, seconds%3600/60, seconds%60
	t := fmt.Sprintf("%dm%ds", m, s)
	if h > 0 {
		t = fmt.Sprintf("%dh%s", h, t)
	} else if m == 0 {
		t = fmt.Sprintf("%ds", s)
	}
	return expand(p.def.LinkAt, "{id}", nativeID, "{t}", t)
}

func (p platform) ChannelURL(channel string) string {
	if p.def.ChannelURL == "" {
		return ""
	}
	return expand(p.def.ChannelURL, "{channel}", channel)
}

func expand(tmpl string, pairs ...string) string {
	return strings.NewReplacer(pairs...).Replace(tmpl)
}

// PickTrack prefers an author-uploaded track and falls back to auto-subtitles.
//
// An extractor may list two entries per language under `subtitles`: one derived
// from the stream manifest (manifest_url set, ext "vtt", no label) and one from
// the player's subtitle list, where `ext` carries the player's label. A label
// containing "auto" means auto-subtitles. A plain "vtt" label is NOT evidence
// of an uploaded track: a video labelled "Автоматические" in the player showed
// up as "vtt" too (checked 2026-10-10), so anything else stays unknown.
func (platform) PickTrack(info *ytdlp.Info, lang string) (t ytdlp.Track, typ transcript.TrackType, auto bool, ok bool) {
	subs := info.Subtitles[lang]
	if len(subs) > 0 {
		typ = transcript.TrackUnknown
		t = subs[0]
		for _, tr := range subs {
			if tr.ManifestURL != "" {
				continue // manifest-derived entry: format only, no label
			}
			t = tr
			if looksAuto(tr) {
				typ = transcript.TrackAuto
			}
			break
		}
		return t, typ, false, true
	}
	if trs := info.AutomaticCaptions[lang]; len(trs) > 0 {
		return trs[0], transcript.TrackAuto, true, true
	}
	return ytdlp.Track{}, transcript.TrackNone, false, false
}

func looksAuto(t ytdlp.Track) bool {
	s := strings.ToLower(t.Name + " " + t.Ext)
	return strings.Contains(s, "auto") || strings.Contains(s, "автомат")
}
