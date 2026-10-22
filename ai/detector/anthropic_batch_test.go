package detector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

func TestAnthropicBatchPoll(t *testing.T) {
	status := "in_progress"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/messages/batches/msgbatch_1":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"id":"msgbatch_1","type":"message_batch","processing_status":"` + status + `"}`))
		case "/v1/messages/batches/msgbatch_1/results":
			w.Header().Set("Content-Type", "application/x-jsonl")
			w.Write([]byte(`{"custom_id":"a","result":{"type":"succeeded","message":{"id":"m","type":"message","role":"assistant","model":"m","stop_reason":"end_turn","content":[{"type":"text","text":"{\"segments\":[]}"}],"usage":{"input_tokens":10,"output_tokens":2}}}}` + "\n" +
				`{"custom_id":"b","result":{"type":"expired"}}` + "\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	b := &AnthropicBatch{
		client:  anthropic.NewClient(option.WithAPIKey("test"), option.WithBaseURL(srv.URL), option.WithMaxRetries(0)),
		model:   "m",
		results: map[string]batchOutcome{},
	}
	ctx := context.Background()

	ended, err := b.Poll(ctx, "msgbatch_1")
	if err != nil || ended {
		t.Fatalf("running batch: ended=%v err=%v", ended, err)
	}
	if _, err := b.Detect(ctx, Request{Key: "a"}); err == nil {
		t.Fatal("running batch: want no results yet")
	}

	status = "ended"
	ended, err = b.Poll(ctx, "msgbatch_1")
	if err != nil || !ended {
		t.Fatalf("ended batch: ended=%v err=%v", ended, err)
	}
	res, err := b.Detect(ctx, Request{Key: "a"})
	if err != nil || res.Usage.InputTokens != 10 || len(res.Output.Segments) != 0 {
		t.Fatalf("succeeded result: %+v %v", res, err)
	}
	if _, err := b.Detect(ctx, Request{Key: "b"}); err == nil {
		t.Fatal("expired result: want an error")
	}
	if _, err := b.Poll(ctx, "msgbatch_unknown"); err == nil {
		t.Fatal("unknown batch: want an error")
	}
}
