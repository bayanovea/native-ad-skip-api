// Package provider holds the per-platform knowledge the pipeline needs: how to
// turn a native id into a URL and how to read the platform's subtitle listing
// out of yt-dlp output. Everything downstream (collapse, transcripts, gold,
// detection, scoring) is provider-agnostic and keys data by (provider, native_id).
package provider

import (
	"fmt"
	"sort"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

// Provider is one video platform.
type Provider interface {
	// Name is the short id used in paths, metadata and flags: "prv", "yt", "rt".
	Name() string
	// VideoURL builds the page URL yt-dlp is pointed at.
	VideoURL(nativeID string) string
	// LinkAt builds the link a person opens in a browser to watch from a given
	// second (review sheets). It may differ from VideoURL, which targets yt-dlp.
	LinkAt(nativeID string, seconds int) string
	// PickTrack chooses the subtitle track to download for lang from the yt-dlp
	// listing. auto reports whether it lives under automatic_captions (selects
	// --write-auto-subs); ok is false when the video has no usable track.
	PickTrack(info *ytdlp.Info, lang string) (t ytdlp.Track, typ transcript.TrackType, auto bool, ok bool)
}

var registry = map[string]Provider{}

// Register adds a provider; called from the providers' init functions.
func Register(p Provider) {
	if _, dup := registry[p.Name()]; dup {
		panic("provider: duplicate " + p.Name())
	}
	registry[p.Name()] = p
}

// Lookup returns the provider registered under name.
func Lookup(name string) (Provider, error) {
	p, ok := registry[name]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q (known: %v)", name, Names())
	}
	return p, nil
}

// Names lists registered providers, sorted.
func Names() []string {
	names := make([]string, 0, len(registry))
	for n := range registry {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}
