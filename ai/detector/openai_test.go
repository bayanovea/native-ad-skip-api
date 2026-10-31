package detector

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openai/openai-go/v3/option"
)

// completion is a recorded-shape Chat Completions response.
func completion(finish, content, refusal string) string {
	b, _ := json.Marshal(map[string]any{
		"id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": "gpt-test",
		"choices": []any{map[string]any{"index": 0, "finish_reason": finish,
			"message": map[string]any{"role": "assistant", "content": content, "refusal": refusal}}},
		"usage": map[string]any{"prompt_tokens": 1000, "completion_tokens": 50, "total_tokens": 1050,
			"prompt_tokens_details": map[string]any{"cached_tokens": 200}},
	})
	return string(b)
}

func openAIServer(t *testing.T, body string, seen *map[string]any) *OpenAI {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if seen != nil {
			_ = json.Unmarshal(b, seen)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("OPENAI_API_KEY", "sk-test")
	c, err := NewOpenAI("gpt-test", "low", option.WithBaseURL(srv.URL), option.WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestOpenAIDetectParsesStructuredOutput(t *testing.T) {
	out := `{"segments":[{"category":"sponsor","first_cue":1,"last_cue":2,"confidence":"high","quote":"a"}]}`
	var req map[string]any
	c := openAIServer(t, completion("stop", out, ""), &req)
	res, err := c.Detect(context.Background(), Request{System: "sys", User: "usr", Schema: Schema})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Output.Segments) != 1 || res.Output.Segments[0].LastCue != 2 {
		t.Fatalf("output: %+v", res.Output)
	}
	if res.Usage != (Usage{InputTokens: 800, OutputTokens: 50, CacheReadTokens: 200}) {
		t.Fatalf("usage: %+v", res.Usage)
	}
	rf, _ := req["response_format"].(map[string]any)
	js, _ := rf["json_schema"].(map[string]any)
	if rf["type"] != "json_schema" || js["strict"] != true || req["reasoning_effort"] != "low" {
		t.Fatalf("request: %v", req)
	}
}

func TestOpenAIDetectErrors(t *testing.T) {
	for name, body := range map[string]string{
		"cut off":  completion("length", `{"segments":[`, ""),
		"refusal":  completion("stop", "", "no"),
		"filtered": completion("content_filter", "", ""),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := openAIServer(t, body, nil).Detect(context.Background(), Request{Schema: Schema}); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

func TestNewOpenAINeedsKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", " ")
	if _, err := NewOpenAI("gpt-test", ""); err == nil || !strings.Contains(err.Error(), "OPENAI_API_KEY") {
		t.Fatalf("want an error naming OPENAI_API_KEY, got %v", err)
	}
}
