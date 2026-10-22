package detector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Anthropic is the Client over the Claude API (Go SDK).
//
// One request per transcript: the prompt as the system text, the rendered
// cues as the only user message, the JSON schema as the response format
// (structured output), so the reply is one text block of schema-valid JSON.
//
// Deliberately not used: prompt caching (the prompt is below the cacheable
// minimum and nothing else repeats between calls), streaming (the output is
// a few hundred tokens), server-side model fallbacks (a fallback would run a
// different model under this run's name and corrupt the comparison).
type Anthropic struct {
	client anthropic.Client
	model  string
	effort string
	// thinking turns adaptive thinking on. Sonnet 5.5 without the parameter answers
	// with the JSON only (~200 output tokens per video, measured), so this is a real switch.
	thinking bool
}

// NewAnthropic builds a client for one model and effort level; the key comes
// from ANTHROPIC_API_KEY.
func NewAnthropic(model, effort string) (*Anthropic, error) {
	if model == "" {
		return nil, errors.New("model is required")
	}
	client, err := newAPIClient()
	if err != nil {
		return nil, err
	}
	return &Anthropic{client: client, model: model, effort: effort}, nil
}

// newAPIClient reads the key from ANTHROPIC_API_KEY only (the deploy env).
func newAPIClient() (anthropic.Client, error) {
	key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
	if key == "" {
		return anthropic.Client{}, errors.New("ANTHROPIC_API_KEY is not set")
	}
	return anthropic.NewClient(option.WithAPIKey(key)), nil
}

// WithThinking sends thinking: {type: adaptive}. Thinking tokens are billed as output.
func (a *Anthropic) WithThinking() *Anthropic { a.thinking = true; return a }

// adaptiveThinking is the request value shared by the sync and the batch client;
// the text is not read, so it is omitted (billing is the same either way).
func adaptiveThinking() anthropic.ThinkingConfigParamUnion {
	return anthropic.ThinkingConfigParamUnion{OfAdaptive: &anthropic.ThinkingConfigAdaptiveParam{Display: anthropic.ThinkingConfigAdaptiveDisplayOmitted}}
}

// Model implements Client.
func (a *Anthropic) Model() string { return a.model }

// maxTokens bounds the reply. The JSON is small, but on models with adaptive
// thinking the thinking tokens count against this limit too, so it is not
// set to the size of the JSON alone.
const maxTokens = 8192

// Detect implements Client.
func (a *Anthropic) Detect(ctx context.Context, req Request) (Result, error) {
	var schema map[string]any
	if err := json.Unmarshal([]byte(req.Schema), &schema); err != nil {
		return Result{}, fmt.Errorf("schema: %w", err)
	}
	params := anthropic.MessageNewParams{
		Model:     a.model,
		MaxTokens: maxTokens,
		System:    []anthropic.TextBlockParam{{Text: req.System}},
		Messages:  []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(req.User))},
		OutputConfig: anthropic.OutputConfigParam{
			Format: anthropic.JSONOutputFormatParam{Schema: schema},
		},
	}
	// Effort exists on the current Opus/Sonnet generation only; Haiku 4.5 rejects it.
	if a.effort != "" && !strings.Contains(a.model, "haiku") {
		params.OutputConfig.Effort = anthropic.OutputConfigEffort(a.effort)
	}

	if a.thinking {
		params.Thinking = adaptiveThinking()
	}

	start := time.Now()
	msg, err := a.client.Messages.New(ctx, params)
	res := Result{Latency: time.Since(start)}
	if err != nil {
		return res, err // the SDK error text carries the HTTP status; detect.go reads it
	}
	return resultFromMessage(msg, res)
}

// resultFromMessage turns a finished message (from the Messages API or from a
// batch result) into a Result: usage, the JSON text block, stop-reason checks.
func resultFromMessage(msg *anthropic.Message, res Result) (Result, error) {
	res.Usage = Usage{
		InputTokens:      int(msg.Usage.InputTokens),
		OutputTokens:     int(msg.Usage.OutputTokens),
		CacheReadTokens:  int(msg.Usage.CacheReadInputTokens),
		CacheWriteTokens: int(msg.Usage.CacheCreationInputTokens),
	}
	var text strings.Builder
	for _, block := range msg.Content {
		if t, ok := block.AsAny().(anthropic.TextBlock); ok {
			text.WriteString(t.Text)
		}
	}
	res.Raw = text.String()

	// The schema guarantees the shape only when the model finished its turn.
	// A cut-off (max_tokens) or a refusal is a failed call for this video.
	switch msg.StopReason {
	case anthropic.StopReasonEndTurn, anthropic.StopReasonStopSequence:
	case anthropic.StopReasonMaxTokens:
		return res, fmt.Errorf("stop_reason max_tokens: output cut off at %d tokens", maxTokens)
	default:
		return res, fmt.Errorf("stop_reason %s", msg.StopReason)
	}
	out, err := ParseOutput(res.Raw)
	if err != nil {
		return res, err
	}
	res.Output = out
	return res, nil
}
