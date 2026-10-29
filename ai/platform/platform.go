// Package platform registers the product's one provider, prv, from the deploy
// env: its URL templates come from PROVIDER_VIDEO_URL and PROVIDER_LINK_AT
// (see ai/provider for the placeholders).
// Product-owned, next to the packages synced from the eval repo.
package platform

import (
	"errors"
	"os"

	"odedohbest/video-calculate/ai/provider"
)

// Name is the provider's code name, the one of the table prefix and the metrics label.
const Name = "prv"

// FromEnv returns prv, registering it on the first call. Only the commands that
// build URLs call it, so a switched-off tick or `ai regate` runs without the variables.
func FromEnv() (provider.Provider, error) {
	if p, err := provider.Lookup(Name); err == nil {
		return p, nil
	}
	videoURL, linkAt := os.Getenv("PROVIDER_VIDEO_URL"), os.Getenv("PROVIDER_LINK_AT")
	if videoURL == "" || linkAt == "" {
		return nil, errors.New("PROVIDER_VIDEO_URL and PROVIDER_LINK_AT must be set: URL templates with {id} (native id) and, for PROVIDER_LINK_AT, {t} (start offset as 1h2m3s)")
	}
	provider.Register(provider.Def{Name: Name, VideoURL: videoURL, LinkAt: linkAt})
	return provider.Lookup(Name)
}
