package detector

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// BatchClient is the batch transport of the detect command: AnthropicBatch in
// production, FixtureClient in tests.
type BatchClient interface {
	Client
	Submit(ctx context.Context, reqs []Request) (string, error)
	Wait(ctx context.Context, batchID string, every time.Duration, progress func(string)) error
}

var (
	_ BatchClient = (*AnthropicBatch)(nil)
	_ BatchClient = (*FixtureClient)(nil)
)

const fixtureBatchPrefix = "fixture-"

// FixtureClient (AI_CLIENT=fixture) answers every request from
// <dir>/<Request.Key>.detect.json, the model's JSON output, so tests never call
// the API. A batch has ended as soon as it is submitted.
type FixtureClient struct {
	dir   string
	model string
}

func NewFixtureClient(dir, model string) *FixtureClient {
	return &FixtureClient{dir: dir, model: model}
}

// Model implements Client.
func (f *FixtureClient) Model() string { return f.model }

// Detect implements Client; a missing fixture is an error, as a failed call.
func (f *FixtureClient) Detect(_ context.Context, req Request) (Result, error) {
	b, err := os.ReadFile(filepath.Join(f.dir, req.Key+".detect.json"))
	if err != nil {
		return Result{}, fmt.Errorf("fixture: %w", err)
	}
	res := Result{Raw: string(b)}
	res.Output, err = ParseOutput(res.Raw)
	return res, err
}

// Submit implements BatchClient.
func (f *FixtureClient) Submit(_ context.Context, reqs []Request) (string, error) {
	keys := make([]string, len(reqs))
	for i, r := range reqs {
		if r.Key == "" {
			return "", fmt.Errorf("fixture: request %d has no key", i)
		}
		keys[i] = r.Key
	}
	return fixtureBatchPrefix + strings.Join(keys, ","), nil
}

// Wait implements BatchClient; it only refuses a batch id another client made.
func (f *FixtureClient) Wait(_ context.Context, batchID string, _ time.Duration, progress func(string)) error {
	if !strings.HasPrefix(batchID, fixtureBatchPrefix) {
		return fmt.Errorf("fixture: not a fixture batch: %s", batchID)
	}
	if progress != nil {
		progress("batch " + batchID + ": ended")
	}
	return nil
}
