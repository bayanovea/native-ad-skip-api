// Package provider holds the per-platform knowledge the pipeline needs: how to
// turn a native id into a URL and how to read the platform's subtitle listing
// out of yt-dlp output. Everything downstream (collapse, transcripts, gold,
// detection, scoring) is provider-agnostic and keys data by (provider, native_id).
//
// No platform is named in this repository: each one is a Def loaded from a
// config file outside the tree (the CLI reads ADSKIP_PROVIDERS or
// ~/.config/native-ad-skip-eval/providers.json), so the code carries only URL
// templates with placeholders.
package provider

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/ytdlp"
)

// Provider is one video platform.
type Provider interface {
	// Name is the short id used in paths, metadata and flags.
	Name() string
	// VideoURL builds the page URL yt-dlp is pointed at.
	VideoURL(nativeID string) string
	// LinkAt builds the link a person opens in a browser to watch from a given
	// second (review sheets). It may differ from VideoURL, which targets yt-dlp.
	LinkAt(nativeID string, seconds int) string
	// ChannelURL builds the listing of a channel's uploads for yt-dlp
	// --flat-playlist; "" when the platform has no such listing.
	ChannelURL(channel string) string
	// PickTrack chooses the subtitle track to download for lang from the yt-dlp
	// listing. auto reports whether it lives under automatic_captions (selects
	// --write-auto-subs); ok is false when the video has no usable track.
	PickTrack(info *ytdlp.Info, lang string) (t ytdlp.Track, typ transcript.TrackType, auto bool, ok bool)
}

// Def describes one platform. Templates take {id} (native id), {t} (start
// offset as 1h2m3s) and {channel}.
type Def struct {
	Name       string `json:"name"`
	VideoURL   string `json:"video_url"`             // page for yt-dlp; {id}
	LinkAt     string `json:"link_at"`               // player link from a second; {id}, {t}
	ChannelURL string `json:"channel_url,omitempty"` // a channel's uploads; {channel}
}

var registry = map[string]Provider{}

// Register adds a platform; a duplicate name or an incomplete Def panics,
// since both are programming or config errors with no sensible recovery.
func Register(d Def) {
	if err := validate(d); err != nil {
		panic("provider: " + err.Error())
	}
	if _, dup := registry[d.Name]; dup {
		panic("provider: duplicate " + d.Name)
	}
	registry[d.Name] = platform{d}
}

func validate(d Def) error {
	switch {
	case d.Name == "":
		return errors.New("def without name")
	case d.VideoURL == "" || d.LinkAt == "":
		return fmt.Errorf("%s: video_url and link_at are required", d.Name)
	}
	return nil
}

// Load registers every platform of a JSON config: {"providers": [Def, ...]}.
func Load(r io.Reader) error {
	var cfg struct {
		Providers []Def `json:"providers"`
	}
	if err := json.NewDecoder(r).Decode(&cfg); err != nil {
		return fmt.Errorf("providers config: %w", err)
	}
	for _, d := range cfg.Providers {
		if err := validate(d); err != nil {
			return fmt.Errorf("providers config: %w", err)
		}
		if _, dup := registry[d.Name]; dup {
			return fmt.Errorf("providers config: duplicate %s", d.Name)
		}
	}
	for _, d := range cfg.Providers {
		Register(d)
	}
	return nil
}

// LoadFile is Load on a path; a missing file registers nothing and is not an
// error, so commands that never touch a platform keep working without config.
func LoadFile(path string) error {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if err := Load(f); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// Lookup returns the provider registered under name.
func Lookup(name string) (Provider, error) {
	p, ok := registry[name]
	if !ok {
		return nil, fmt.Errorf("unknown provider %q (configured: %v)", name, Names())
	}
	return p, nil
}

// Resolve is Lookup with "" meaning the only configured provider, which is the
// default of every -provider flag.
func Resolve(name string) (Provider, error) {
	if name != "" {
		return Lookup(name)
	}
	names := Names()
	if len(names) != 1 {
		return nil, fmt.Errorf("-provider is required: configured providers %v (see providers.json)", names)
	}
	return registry[names[0]], nil
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
