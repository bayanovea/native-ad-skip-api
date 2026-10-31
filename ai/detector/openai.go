package detector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/shared"
)

// OpenAI is the Client over the OpenAI Chat Completions API, the same request
// as Anthropic: the prompt as the system text, the rendered cues as the only
// user message, Schema as a strict JSON-schema response format.
type OpenAI struct {
	client openai.Client
	model  string
	effort string
}

// NewOpenAI builds a client for one model and reasoning effort; the key comes
// from OPENAI_API_KEY only, so the product can take this file as is.
func NewOpenAI(model, effort string, opts ...option.RequestOption) (*OpenAI, error) {
	if model == "" {
		return nil, errors.New("model is required")
	}
	key := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if key == "" {
		return nil, errors.New("OPENAI_API_KEY is not set")
	}
	opts = append([]option.RequestOption{option.WithAPIKey(key)}, opts...)
	return &OpenAI{client: openai.NewClient(opts...), model: model, effort: effort}, nil
}

// Model implements Client.
func (o *OpenAI) Model() string { return o.model }

// Detect implements Client.
func (o *OpenAI) Detect(ctx context.Context, req Request) (Result, error) {
	var schema map[string]any
	if err := json.Unmarshal([]byte(req.Schema), &schema); err != nil {
		return Result{}, fmt.Errorf("schema: %w", err)
	}
	params := openai.ChatCompletionNewParams{
		Model:               o.model,
		MaxCompletionTokens: openai.Int(maxTokens),
		Messages:            []openai.ChatCompletionMessageParamUnion{openai.SystemMessage(req.System), openai.UserMessage(req.User)},
		ResponseFormat: openai.ChatCompletionNewParamsResponseFormatUnion{OfJSONSchema: &shared.ResponseFormatJSONSchemaParam{
			JSONSchema: shared.ResponseFormatJSONSchemaJSONSchemaParam{Name: "segments", Schema: schema, Strict: openai.Bool(true)},
		}},
	}
	if o.effort != "" {
		params.ReasoningEffort = shared.ReasoningEffort(o.effort)
	}
	start := time.Now()
	resp, err := o.client.Chat.Completions.New(ctx, params)
	res := Result{Latency: time.Since(start)}
	if err != nil {
		return res, err
	}
	return resultFromCompletion(resp, res)
}

// resultFromCompletion maps the response the way resultFromMessage does. The
// API counts cached tokens inside prompt_tokens; Usage keeps them apart.
func resultFromCompletion(resp *openai.ChatCompletion, res Result) (Result, error) {
	cached := int(resp.Usage.PromptTokensDetails.CachedTokens)
	res.Usage = Usage{
		InputTokens:     int(resp.Usage.PromptTokens) - cached,
		OutputTokens:    int(resp.Usage.CompletionTokens),
		CacheReadTokens: cached,
	}
	if len(resp.Choices) == 0 {
		return res, errors.New("no choices in the response")
	}
	c := resp.Choices[0]
	res.Raw = c.Message.Content
	switch {
	case c.Message.Refusal != "":
		return res, fmt.Errorf("refusal: %s", c.Message.Refusal)
	case c.FinishReason == "length":
		return res, fmt.Errorf("finish_reason length: output cut off at %d tokens", maxTokens)
	case c.FinishReason != "stop":
		return res, fmt.Errorf("finish_reason %s", c.FinishReason)
	}
	out, err := ParseOutput(res.Raw)
	if err != nil {
		return res, err
	}
	res.Output = out
	return res, nil
}
