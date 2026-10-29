package ytdlp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRetryStopsAfterAttempts(t *testing.T) {
	r := &Runner{Attempts: 3, Backoff: time.Millisecond}
	calls := 0
	err := r.retry(context.Background(), "x", func(context.Context) error {
		calls++
		return errors.New("boom")
	})
	if calls != 3 || err == nil {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestRetrySucceedsEventually(t *testing.T) {
	r := &Runner{Attempts: 3, Backoff: time.Millisecond}
	calls := 0
	err := r.retry(context.Background(), "x", func(context.Context) error {
		calls++
		if calls < 2 {
			return errors.New("flaky")
		}
		return nil
	})
	if calls != 2 || err != nil {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}

func TestRunMissingBinary(t *testing.T) {
	r := &Runner{Bin: "/nonexistent/yt-dlp", Attempts: 1}
	if _, _, err := r.Info(context.Background(), "https://example.invalid"); err == nil {
		t.Fatal("expected error")
	}
}

// A track with only the player's entry has its label as ext: yt-dlp writes
// "<base>.ru.Ru AUTO", and callers read "<base>.ru.vtt".
func TestWriteSubsRenamesLabelExt(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "yt-dlp")
	script := "#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  case \"$1\" in -o) out=$2; shift ;; allow-unsafe-ext) ok=1 ;; esac\n  shift\ndone\n" +
		"[ -n \"$ok\" ] || { echo 'ERROR: unusual extension' >&2; exit 1; }\nprintf 'WEBVTT\\n' > \"$out.ru.Ru AUTO\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(dir, "subs")
	r := &Runner{Bin: bin, Attempts: 1}
	if err := r.WriteSubs(context.Background(), "https://example.invalid", base, "ru", false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(base + ".ru.vtt")
	if err != nil || string(got) != "WEBVTT\n" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := os.Stat(base + ".ru.Ru AUTO"); !os.IsNotExist(err) {
		t.Fatalf("label file left behind: %v", err)
	}
}

func TestNormalizeSubsExtKeepsVTT(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, "subs")
	for name, body := range map[string]string{".ru.vtt": "manifest", ".ru.Ru AUTO": "player"} {
		if err := os.WriteFile(base+name, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := normalizeSubsExt(base, "ru"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(base + ".ru.vtt"); string(got) != "manifest" {
		t.Fatalf("vtt overwritten: %q", got)
	}
}
