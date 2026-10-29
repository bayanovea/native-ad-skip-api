package platform

import (
	"strings"
	"testing"
)

// One registration per test binary: the missing-variable cases run first, then
// the e2e values of docker-compose.e2e.yml register prv for the rest.
func TestFromEnv(t *testing.T) {
	for name, env := range map[string][2]string{
		"both missing": {"", ""},
		"no link_at":   {"https://example.invalid/video{id}", ""},
		"no video_url": {"", "https://example.invalid/video{id}?t={t}"},
	} {
		t.Setenv("PROVIDER_VIDEO_URL", env[0])
		t.Setenv("PROVIDER_LINK_AT", env[1])
		if _, err := FromEnv(); err == nil || !strings.Contains(err.Error(), "PROVIDER_VIDEO_URL and PROVIDER_LINK_AT must be set") {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
	t.Setenv("PROVIDER_VIDEO_URL", "https://example.invalid/video{id}")
	t.Setenv("PROVIDER_LINK_AT", "https://example.invalid/video{id}?t={t}")
	p, err := FromEnv()
	if err != nil || p.Name() != Name {
		t.Fatalf("FromEnv: %v, %v", p, err)
	}
	if got := p.VideoURL("-1_456000001"); got != "https://example.invalid/video-1_456000001" {
		t.Errorf("VideoURL = %s", got)
	}
	if got := p.LinkAt("-1_456000001", 1992); got != "https://example.invalid/video-1_456000001?t=33m12s" {
		t.Errorf("LinkAt = %s", got)
	}
	t.Setenv("PROVIDER_VIDEO_URL", "")
	if again, err := FromEnv(); err != nil || again != p {
		t.Errorf("second call must return the registered provider, got %v, %v", again, err)
	}
}
