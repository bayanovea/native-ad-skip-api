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
	dir    string
	model  string
	suffix string
}

func NewFixtureClient(dir, model string) *FixtureClient {
	return NewFixtureClientSuffix(dir, model, ".detect.json")
}

// NewFixtureClientSuffix reads <Key><suffix> instead (AI_SECOND_CLIENT=fixture:
// ".second.json"); a <Key>.second-error file (the suffix's stem + "-error") makes
// Detect fail with its text, as an API error.
func NewFixtureClientSuffix(dir, model, suffix string) *FixtureClient {
	return &FixtureClient{dir: dir, model: model, suffix: suffix}
}

// Model implements Client.
func (f *FixtureClient) Model() string { return f.model }

// FixtureUsage is what every fixture answer reports, so tests see a cost.
var FixtureUsage = Usage{InputTokens: 10000, OutputTokens: 200}

// Detect implements Client; a missing fixture is an error, as a failed call.
func (f *FixtureClient) Detect(_ context.Context, req Request) (Result, error) {
	if b, err := os.ReadFile(filepath.Join(f.dir, req.Key+strings.TrimSuffix(f.suffix, ".json")+"-error")); err == nil {
		return Result{}, fmt.Errorf("fixture: %s", strings.TrimSpace(string(b)))
	}
	b, err := os.ReadFile(filepath.Join(f.dir, req.Key+f.suffix))
	if err != nil {
		return Result{}, fmt.Errorf("fixture: %w", err)
	}
	res := Result{Raw: string(b), Usage: FixtureUsage}
	res.Output, err = ParseOutput(res.Raw)
	return res, err
}

// Submit is the batch call: the batch id lists the keys. A <Key>.submit-error file
// for any request rejects the whole batch with its text, as the API rejects a submit.
func (f *FixtureClient) Submit(_ context.Context, reqs []Request) (string, error) {
	keys := make([]string, len(reqs))
	for i, r := range reqs {
		if r.Key == "" {
			return "", fmt.Errorf("fixture: request %d has no key", i)
		}
		if b, err := os.ReadFile(filepath.Join(f.dir, r.Key+".submit-error")); err == nil {
			return "", fmt.Errorf("fixture: %s", strings.TrimSpace(string(b)))
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
