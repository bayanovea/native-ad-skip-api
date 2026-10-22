package detector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
)

// AnthropicBatch is the Client over the Message Batches API: the same request
// as Anthropic.Detect, submitted in bulk, asynchronous, billed at half price.
//
// Usage: Submit all requests (or Attach to an existing batch), Wait until the
// batch has ended, then call Detect per request; Detect answers from the
// collected results by Request.Key and never touches the network. This keeps
// the CLI loop identical for every transport.
//
// A batch result carries no latency (the time is queue time, not model time),
// so Result.Latency is zero for this client.
type AnthropicBatch struct {
	client   anthropic.Client
	model    string
	effort   string
	thinking bool
	mu       sync.Mutex
	results  map[string]batchOutcome
}

type batchOutcome struct {
	res Result
	err error
}

// NewAnthropicBatch builds the client; the key as for Anthropic.
func NewAnthropicBatch(model, effort string) (*AnthropicBatch, error) {
	if model == "" {
		return nil, errors.New("model is required")
	}
	client, err := newAPIClient()
	if err != nil {
		return nil, err
	}
	return &AnthropicBatch{client: client, model: model, effort: effort, results: map[string]batchOutcome{}}, nil
}

// WithThinking sends thinking: {type: adaptive} on every request of the batch.
func (b *AnthropicBatch) WithThinking() *AnthropicBatch { b.thinking = true; return b }

// Model implements Client.
func (b *AnthropicBatch) Model() string { return b.model }

// Submit sends all requests as one batch and returns the batch id. Keys must be
// unique and match [A-Za-z0-9_-]{1,64} (a native video id does).
func (b *AnthropicBatch) Submit(ctx context.Context, reqs []Request) (string, error) {
	var items []anthropic.MessageBatchNewParamsRequest
	for _, r := range reqs {
		var schema map[string]any
		if err := json.Unmarshal([]byte(r.Schema), &schema); err != nil {
			return "", fmt.Errorf("schema: %w", err)
		}
		p := anthropic.MessageBatchNewParamsRequestParams{
			Model:     anthropic.Model(b.model),
			MaxTokens: maxTokens,
			System:    []anthropic.TextBlockParam{{Text: r.System}},
			Messages:  []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(r.User))},
			OutputConfig: anthropic.OutputConfigParam{
				Format: anthropic.JSONOutputFormatParam{Schema: schema},
			},
		}
		if b.effort != "" && !strings.Contains(b.model, "haiku") {
			p.OutputConfig.Effort = anthropic.OutputConfigEffort(b.effort)
		}
		if b.thinking {
			p.Thinking = adaptiveThinking()
		}
		items = append(items, anthropic.MessageBatchNewParamsRequest{CustomID: r.Key, Params: p})
	}
	batch, err := b.client.Messages.Batches.New(ctx, anthropic.MessageBatchNewParams{Requests: items})
	if err != nil {
		return "", err
	}
	return batch.ID, nil
}

// Wait polls until the batch has ended, then loads every result. progress, if
// set, is called after each poll with a short status line.
func (b *AnthropicBatch) Wait(ctx context.Context, batchID string, every time.Duration, progress func(string)) error {
	for {
		batch, err := b.client.Messages.Batches.Get(ctx, batchID, anthropic.MessageBatchGetParams{})
		if err != nil {
			return err
		}
		if progress != nil {
			c := batch.RequestCounts
			progress(fmt.Sprintf("batch %s: %s (processing %d, succeeded %d, errored %d, canceled %d, expired %d)",
				batchID, batch.ProcessingStatus, c.Processing, c.Succeeded, c.Errored, c.Canceled, c.Expired))
		}
		if batch.ProcessingStatus == anthropic.MessageBatchProcessingStatusEnded {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
	stream := b.client.Messages.Batches.ResultsStreaming(ctx, batchID, anthropic.MessageBatchResultsParams{})
	defer stream.Close()
	b.mu.Lock()
	defer b.mu.Unlock()
	for stream.Next() {
		item := stream.Current()
		switch item.Result.Type {
		case "succeeded":
			msg := item.Result.Message
			res, err := resultFromMessage(&msg, Result{})
			b.results[item.CustomID] = batchOutcome{res, err}
		case "errored":
			b.results[item.CustomID] = batchOutcome{err: fmt.Errorf("batch request errored: %s", item.Result.Error.Error.Message)}
		default: // canceled, expired
			b.results[item.CustomID] = batchOutcome{err: fmt.Errorf("batch request %s", item.Result.Type)}
		}
	}
	return stream.Err()
}

// Detect implements Client from the collected results.
func (b *AnthropicBatch) Detect(_ context.Context, req Request) (Result, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o, ok := b.results[req.Key]
	if !ok {
		return Result{}, fmt.Errorf("batch has no result for %q", req.Key)
	}
	return o.res, o.err
}
