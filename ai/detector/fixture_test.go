package detector

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestFixtureClient(t *testing.T) {
	dir := t.TempDir()
	out := `{"segments":[{"category":"sponsor","first_cue":3,"last_cue":7,"confidence":"high","quote":"а теперь"}]}`
	if err := os.WriteFile(filepath.Join(dir, "-1_456000001.detect.json"), []byte(out), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	f := NewFixtureClient(dir, "claude-sonnet-5-5")

	res, err := f.Detect(ctx, Request{Key: "-1_456000001"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Output.Segments) != 1 || res.Output.Segments[0].LastCue != 7 || res.Raw != out {
		t.Fatalf("got %+v", res)
	}
	if _, err := f.Detect(ctx, Request{Key: "-1_456000002"}); err == nil {
		t.Fatal("missing fixture: want an error")
	}

	id, err := f.Submit(ctx, []Request{{Key: "-1_456000001"}, {Key: "-1_456000002"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Detect(ctx, Request{Key: "-1_456000001"}); err != nil {
		t.Fatalf("batch path: %v", err)
	}
	if ended, err := f.Poll(ctx, id); err != nil || !ended {
		t.Fatalf("poll: ended=%v err=%v", ended, err)
	}
	if _, err := f.Poll(ctx, "msgbatch_01"); err == nil {
		t.Fatal("foreign batch id: want an error")
	}
	if _, err := f.Submit(ctx, []Request{{}}); err == nil {
		t.Fatal("request without a key: want an error")
	}
}
