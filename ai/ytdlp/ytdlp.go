// Package ytdlp is a thin wrapper over the yt-dlp binary: metadata lookup and
// subtitle download, each with bounded retries and exponential backoff.
package ytdlp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Track is one subtitle track as reported by yt-dlp.
//
// An extractor may report two entries per language: one derived from the stream
// manifest (ManifestURL set, Ext "vtt") and one from the player's subtitle list,
// where Ext carries the player's label ("vtt" or "Ru AUTO") rather than a format.
type Track struct {
	Ext         string `json:"ext"`
	URL         string `json:"url"`
	Name        string `json:"name"`
	ManifestURL string `json:"manifest_url"`
}

// Info is the subset of `yt-dlp -j` output we use.
type Info struct {
	ID                string             `json:"id"`
	Title             string             `json:"title"`
	Duration          float64            `json:"duration"`
	Subtitles         map[string][]Track `json:"subtitles"`
	AutomaticCaptions map[string][]Track `json:"automatic_captions"`
}

// Runner executes yt-dlp.
type Runner struct {
	Bin      string        // path to yt-dlp
	Proxy    string        // optional, passed as --proxy
	Attempts int           // total attempts per call (>= 1)
	Timeout  time.Duration // per attempt
	Backoff  time.Duration // first wait; doubles each retry
	Logf     func(format string, args ...any)
}

// Info fetches metadata without downloading media. Raw JSON is returned too, for caching.
func (r *Runner) Info(ctx context.Context, url string) (*Info, []byte, error) {
	var raw []byte
	err := r.retry(ctx, "info "+url, func(ctx context.Context) error {
		out, err := r.run(ctx, "-j", "--skip-download", "--no-warnings", url)
		if err != nil {
			return err
		}
		raw = out
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	var info Info
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, nil, fmt.Errorf("ytdlp: parse -j output: %w", err)
	}
	return &info, raw, nil
}

// WriteSubs downloads subtitle tracks for lang as VTT into outBase (yt-dlp appends
// ".<lang>.vtt"). auto selects --write-auto-subs instead of --write-subs.
//
// A video whose only track is the player's (no manifest entry) has the label as
// its ext ("Ru AUTO"), so yt-dlp writes "<outBase>.ru.Ru AUTO", a VTT file all the
// same; yt-dlp refuses such an ext unless allow-unsafe-ext, which is safe here (a
// fixed name in our own directory, read as text only), and the file is renamed to
// the ".<lang>.vtt" callers look for.
func (r *Runner) WriteSubs(ctx context.Context, url, outBase, lang string, auto bool) error {
	flag := "--write-subs"
	if auto {
		flag = "--write-auto-subs"
	}
	err := r.retry(ctx, "subs "+url, func(ctx context.Context) error {
		_, err := r.run(ctx, flag, "--sub-langs", lang, "--sub-format", "vtt",
			"--compat-options", "allow-unsafe-ext",
			"--skip-download", "--no-warnings", "-o", outBase, url)
		return err
	})
	if err != nil {
		return err
	}
	return normalizeSubsExt(outBase, lang)
}

// normalizeSubsExt renames a "<outBase>.<lang>.<label>" track to "<outBase>.<lang>.vtt"
// when no .vtt was written.
func normalizeSubsExt(outBase, lang string) error {
	want := outBase + "." + lang + ".vtt"
	if _, err := os.Stat(want); err == nil {
		return nil
	}
	matches, _ := filepath.Glob(outBase + "." + lang + ".*")
	for _, m := range matches {
		if !strings.HasSuffix(m, ".vtt") {
			return os.Rename(m, want)
		}
	}
	return nil
}

func (r *Runner) run(ctx context.Context, args ...string) ([]byte, error) {
	if r.Proxy != "" {
		args = append([]string{"--proxy", r.Proxy}, args...)
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Bin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = "…" + msg[len(msg)-300:]
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ytdlp: timeout after %s: %s", timeout, msg)
		}
		return nil, fmt.Errorf("ytdlp: %w: %s", err, msg)
	}
	return stdout.Bytes(), nil
}

// retry runs fn up to r.Attempts times with doubling backoff. Context cancellation stops it.
func (r *Runner) retry(ctx context.Context, what string, fn func(context.Context) error) error {
	attempts := r.Attempts
	if attempts < 1 {
		attempts = 1
	}
	wait := r.Backoff
	if wait <= 0 {
		wait = 2 * time.Second
	}
	var last error
	for i := 1; i <= attempts; i++ {
		last = fn(ctx)
		if last == nil {
			return nil
		}
		if i == attempts || ctx.Err() != nil {
			break
		}
		if r.Logf != nil {
			r.Logf("  %s: attempt %d/%d failed (%v); retry in %s", what, i, attempts, last, wait)
		}
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return ctx.Err()
		}
		wait *= 2
	}
	return errors.Join(fmt.Errorf("ytdlp: %s: gave up after %d attempts", what, attempts), last)
}
