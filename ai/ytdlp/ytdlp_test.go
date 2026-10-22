package ytdlp

import (
	"context"
	"errors"
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
