package detector

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/openai/openai-go/v3/option"
)

// openAIBatchServer serves one batch, b_1, with the given status and files.
func openAIBatchServer(t *testing.T, status *string, output, errFile string, uploaded *string) *OpenAIBatch {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/files":
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Errorf("upload: %v", err)
			}
			f, _, _ := r.FormFile("file")
			b, _ := io.ReadAll(f)
			*uploaded = string(b) + "purpose=" + r.FormValue("purpose")
			io.WriteString(w, `{"id":"file_in","object":"file","purpose":"batch"}`)
		case "/batches":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["input_file_id"] != "file_in" || body["endpoint"] != "/v1/chat/completions" || body["completion_window"] != "24h" {
				t.Errorf("create batch: %v", body)
			}
			io.WriteString(w, `{"id":"b_1","object":"batch","status":"validating"}`)
		case "/batches/b_1":
			b, _ := json.Marshal(map[string]any{"id": "b_1", "object": "batch", "status": *status,
				"output_file_id": "file_out", "error_file_id": "file_err",
				"errors": map[string]any{"data": []any{map[string]any{"code": "invalid_model", "message": "no such model"}}}})
			w.Write(b)
		case "/files/file_out/content":
			io.WriteString(w, output)
		case "/files/file_err/content":
			io.WriteString(w, errFile)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("OPENAI_API_KEY", "sk-test")
	c, err := NewOpenAIBatch("gpt-test", "medium", option.WithBaseURL(srv.URL), option.WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func batchLine(key string, status int, body string) string {
	return fmt.Sprintf(`{"id":"r_%s","custom_id":"%s","response":{"status_code":%d,"body":%s},"error":null}`+"\n", key, key, status, body)
}

func TestOpenAIBatchSubmitAndPoll(t *testing.T) {
	out := `{"segments":[{"category":"sponsor","first_cue":1,"last_cue":2,"confidence":"high","quote":"a"}]}`
	output := batchLine("a", 200, completion("stop", out, "")) + batchLine("b", 200, completion("stop", `{"segments":[]}`, ""))
	errs := `{"id":"r_c","custom_id":"c","response":null,"error":{"code":"batch_expired","message":"not completed in time"}}` + "\n" +
		batchLine("d", 400, `{"error":{"message":"bad request"}}`)
	status, uploaded := "in_progress", ""
	c := openAIBatchServer(t, &status, output, errs, &uploaded)
	ctx := context.Background()

	id, err := c.Submit(ctx, []Request{{Key: "a", System: "sys", User: "usr", Schema: Schema}, {Key: "b", Schema: Schema}})
	if err != nil || id != "b_1" {
		t.Fatalf("submit: %q %v", id, err)
	}
	first := strings.SplitN(uploaded, "\n", 2)[0]
	var line struct {
		CustomID string         `json:"custom_id"`
		Method   string         `json:"method"`
		URL      string         `json:"url"`
		Body     map[string]any `json:"body"`
	}
	_ = json.Unmarshal([]byte(first), &line)
	if !strings.HasSuffix(uploaded, "purpose=batch") || line.Method != "POST" || line.URL != "/v1/chat/completions" || line.CustomID != "a" ||
		line.Body["model"] != "gpt-test" || line.Body["reasoning_effort"] != "medium" {
		t.Fatalf("uploaded file: %s", uploaded)
	}

	if ended, err := c.Poll(ctx, "b_1"); err != nil || ended {
		t.Fatalf("running batch: ended=%v err=%v", ended, err)
	}
	if _, err := c.Detect(ctx, Request{Key: "a"}); err == nil {
		t.Fatal("running batch: want no results yet")
	}

	status = "completed"
	if ended, err := c.Poll(ctx, "b_1"); err != nil || !ended {
		t.Fatalf("completed batch: ended=%v err=%v", ended, err)
	}
	res, err := c.Detect(ctx, Request{Key: "a"})
	if err != nil || len(res.Output.Segments) != 1 || res.Usage != (Usage{InputTokens: 800, OutputTokens: 50, CacheReadTokens: 200}) {
		t.Fatalf("answer a: %+v %v", res, err)
	}
	if res, err := c.Detect(ctx, Request{Key: "b"}); err != nil || len(res.Output.Segments) != 0 {
		t.Fatalf("answer b: %+v %v", res, err)
	}
	for key, want := range map[string]string{"c": "batch_expired", "d": "status 400", "e": "no result"} {
		if _, err := c.Detect(ctx, Request{Key: key}); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("request %s: want an error with %q, got %v", key, want, err)
		}
	}
}

func TestOpenAIBatchEndedStatuses(t *testing.T) {
	for _, s := range []string{"expired", "failed", "cancelled"} {
		t.Run(s, func(t *testing.T) {
			status, uploaded := s, ""
			c := openAIBatchServer(t, &status, "", "", &uploaded)
			if ended, err := c.Poll(context.Background(), "b_1"); err != nil || !ended {
				t.Fatalf("ended=%v err=%v", ended, err)
			}
			_, err := c.Detect(context.Background(), Request{Key: "a"})
			if err == nil || !strings.Contains(err.Error(), "b_1 "+s) || !strings.Contains(err.Error(), "no such model") {
				t.Fatalf("want an error naming the batch's end, got %v", err)
			}
			if errors.Is(err, ErrBatchFailed) != (s == "failed") {
				t.Fatalf("ErrBatchFailed only for a failed batch, got %v", err)
			}
		})
	}
}

func TestNewOpenAIBatchNeedsKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	if _, err := NewOpenAIBatch("gpt-test", ""); err == nil || !strings.Contains(err.Error(), "OPENAI_API_KEY") {
		t.Fatalf("want an error naming OPENAI_API_KEY, got %v", err)
	}
}
