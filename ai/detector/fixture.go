package detector

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

// FixtureUsage is what every fixture answer reports, so tests see a cost.
var FixtureUsage = Usage{InputTokens: 10000, OutputTokens: 200}

// Detect implements Client; a missing fixture is an error, as a failed call.
func (f *FixtureClient) Detect(_ context.Context, req Request) (Result, error) {
	b, err := os.ReadFile(filepath.Join(f.dir, req.Key+".detect.json"))
	if err != nil {
		return Result{}, fmt.Errorf("fixture: %w", err)
	}
	res := Result{Raw: string(b), Usage: FixtureUsage}
	res.Output, err = ParseOutput(res.Raw)
	return res, err
}

// Submit is the batch call: the batch id lists the keys.
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

// Poll: a fixture batch has always ended; a batch id another client made is refused.
func (f *FixtureClient) Poll(_ context.Context, batchID string) (bool, error) {
	if !strings.HasPrefix(batchID, fixtureBatchPrefix) {
		return false, fmt.Errorf("fixture: not a fixture batch: %s", batchID)
	}
	return true, nil
}
