package detector

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
)

// OpenAIBatch is the Client over the OpenAI Batch API: the same request as
// OpenAI.Detect, uploaded as a JSONL file, asynchronous, billed at half price.
// It is used the way AnthropicBatch is: Submit, Wait or Poll, then Detect per
// request from the loaded results. Result.Latency is zero, as there.
type OpenAIBatch struct {
	client  openai.Client
	model   string
	effort  string
	mu      sync.Mutex
	results map[string]batchOutcome
	ended   string // how the last loaded batch ended, for a request with no line in either file
	failed  bool   // the last loaded batch failed as a whole
}

// ErrBatchFailed marks a request of a batch the vendor failed as a whole (validation, the
// organization's enqueued-token limit): nothing was processed or billed, so it may be sent again.
var ErrBatchFailed = errors.New("batch failed")

// NewOpenAIBatch builds the client; the key as for OpenAI.
func NewOpenAIBatch(model, effort string, opts ...option.RequestOption) (*OpenAIBatch, error) {
	if model == "" {
		return nil, errors.New("model is required")
	}
	client, err := newOpenAIClient(opts...)
	if err != nil {
		return nil, err
	}
	return &OpenAIBatch{client: client, model: model, effort: effort, results: map[string]batchOutcome{}}, nil
}

// Model implements Client.
func (b *OpenAIBatch) Model() string { return b.model }

// Submit uploads all requests as one JSONL file, creates a batch over it and
// returns the batch id. Keys must be unique (custom_id).
func (b *OpenAIBatch) Submit(ctx context.Context, reqs []Request) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, r := range reqs {
		params, err := chatParams(b.model, b.effort, r)
		if err != nil {
			return "", err
		}
		line := map[string]any{"custom_id": r.Key, "method": "POST", "url": "/v1/chat/completions", "body": params}
		if err := enc.Encode(line); err != nil {
			return "", err
		}
	}
	f, err := b.client.Files.New(ctx, openai.FileNewParams{
		File:    openai.File(&buf, "batch.jsonl", "application/jsonl"),
		Purpose: openai.FilePurposeBatch,
	})
	if err != nil {
		return "", fmt.Errorf("upload: %w", err)
	}
	batch, err := b.client.Batches.New(ctx, openai.BatchNewParams{
		InputFileID:      f.ID,
		Endpoint:         openai.BatchNewParamsEndpointV1ChatCompletions,
		CompletionWindow: openai.BatchNewParamsCompletionWindow24h,
	})
	if err != nil {
		return "", err
	}
	return batch.ID, nil
}

// Wait polls until the batch has ended, then loads every result; progress as
// for AnthropicBatch.Wait.
func (b *OpenAIBatch) Wait(ctx context.Context, batchID string, every time.Duration, progress func(string)) error {
	for {
		batch, err := b.client.Batches.Get(ctx, batchID)
		if err != nil {
			return err
		}
		if progress != nil {
			c := batch.RequestCounts
			progress(fmt.Sprintf("batch %s: %s (total %d, completed %d, failed %d)", batchID, batch.Status, c.Total, c.Completed, c.Failed))
		}
		if openAIBatchEnded(batch.Status) {
			return b.load(ctx, batch)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(every):
		}
	}
}

// Poll checks the batch once and, when it has ended, loads every result.
func (b *OpenAIBatch) Poll(ctx context.Context, batchID string) (bool, error) {
	batch, err := b.client.Batches.Get(ctx, batchID)
	if err != nil {
		return false, err
	}
	if !openAIBatchEnded(batch.Status) {
		return false, nil
	}
	return true, b.load(ctx, batch)
}

func openAIBatchEnded(s openai.BatchStatus) bool {
	switch s {
	case openai.BatchStatusCompleted, openai.BatchStatusExpired, openai.BatchStatusFailed, openai.BatchStatusCancelled:
		return true
	}
	return false
}

// openAIBatchLine is one line of a batch's output or error file.
type openAIBatchLine struct {
	CustomID string `json:"custom_id"`
	Response *struct {
		StatusCode int             `json:"status_code"`
		Body       json.RawMessage `json:"body"`
	} `json:"response"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// load reads the output and the error file of an ended batch into b.results.
// A failed batch (rejected at validation) has neither; its errors go to b.ended.
func (b *OpenAIBatch) load(ctx context.Context, batch *openai.Batch) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ended = fmt.Sprintf("batch %s %s", batch.ID, batch.Status)
	b.failed = batch.Status == openai.BatchStatusFailed
	for _, e := range batch.Errors.Data {
		b.ended += fmt.Sprintf("; %s: %s", e.Code, e.Message)
	}
	for _, id := range []string{batch.OutputFileID, batch.ErrorFileID} {
		if id == "" {
			continue
		}
		if err := b.loadFile(ctx, id); err != nil {
			return fmt.Errorf("file %s: %w", id, err)
		}
	}
	return nil
}

func (b *OpenAIBatch) loadFile(ctx context.Context, fileID string) error {
	resp, err := b.client.Files.Content(ctx, fileID)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		if len(bytes.TrimSpace(sc.Bytes())) == 0 {
			continue
		}
		var line openAIBatchLine
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			return err
		}
		b.results[line.CustomID] = outcomeFromLine(line)
	}
	return sc.Err()
}

func outcomeFromLine(line openAIBatchLine) batchOutcome {
	switch {
	case line.Error != nil:
		return batchOutcome{err: fmt.Errorf("batch request failed: %s: %s", line.Error.Code, line.Error.Message)}
	case line.Response == nil:
		return batchOutcome{err: errors.New("batch request has no response")}
	case line.Response.StatusCode != 200:
		return batchOutcome{err: fmt.Errorf("batch request failed: status %d: %s", line.Response.StatusCode, line.Response.Body)}
	}
	var c openai.ChatCompletion
	if err := json.Unmarshal(line.Response.Body, &c); err != nil {
		return batchOutcome{err: fmt.Errorf("batch response: %w", err)}
	}
	res, err := resultFromCompletion(&c, Result{})
	return batchOutcome{res, err}
}

// Detect implements Client from the loaded results.
func (b *OpenAIBatch) Detect(_ context.Context, req Request) (Result, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	o, ok := b.results[req.Key]
	if !ok && b.failed {
		return Result{}, fmt.Errorf("%w: no result for %q (%s)", ErrBatchFailed, req.Key, b.ended)
	}
	if !ok && b.ended != "" {
		return Result{}, fmt.Errorf("batch has no result for %q (%s)", req.Key, b.ended)
	}
	if !ok {
		return Result{}, fmt.Errorf("batch has no result for %q", req.Key)
	}
	return o.res, o.err
}
