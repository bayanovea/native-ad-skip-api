package judge

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/vtt"
)

func TestParseOutput(t *testing.T) {
	for _, c := range []struct {
		raw, err string
	}{
		{`{"decision":"withdraw","reason":"r","segments":[{"index":0,"keep":false},{"index":1,"keep":true}]}`, ""},
		{`{"decision":"ok","reason":"r","segments":[{"index":1,"keep":true},{"index":0,"keep":true}]}`, ""},
		{`{"decision":"ok","reason":"r","segments":[]}`, "0 segments answered, the video has 2"},
		{`{"decision":"review","reason":"r","segments":[{"index":0,"keep":true}]}`, "1 segments answered"},
		{`{"decision":"ok","reason":"r","segments":[{"index":0,"keep":true},{"index":1,"keep":false}]}`, "ok with keep false on segment 1"},
		{`not json`, "parse"},
		{`{"decision":"ok","reason":"r","segments":[],"extra":1}`, "parse"},
		{`stop_reason max_tokens: {"decision":"ok"`, "parse"},
		{`{"decision":"maybe","reason":"r","segments":[]}`, "unknown decision"},
		{`{"decision":"ok","reason":" ","segments":[]}`, "empty reason"},
		{`{"decision":"review","reason":"r","segments":[{"index":2,"keep":true}]}`, "outside 0..1"},
		{`{"decision":"review","reason":"r","segments":[{"index":0,"keep":true},{"index":0,"keep":false}]}`, "twice"},
	} {
		_, err := parseOutput(c.raw, 2)
		if (c.err == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), c.err)) {
			t.Errorf("%s: got %v, want %q", c.raw, err, c.err)
		}
	}
}

func TestDisagreementWindows(t *testing.T) {
	entries := []Entry{{CategoryID: 2, Start: 30, End: 70}, {CategoryID: 2, Start: 150, End: 160}, {CategoryID: 2, Start: 400, End: 420}}
	humans := []humanNote{
		{humanInterval: humanInterval{2, 100, 120, 0}, Conflicting: true},  // overlaps the first two windows: one window
		{humanInterval: humanInterval{2, 405, 418, 0}, Conflicting: false}, // agrees: no window of its own
		{humanInterval: humanInterval{2, 900, 930, 0}, Conflicting: true},
	}
	got := disagreementWindows(entries, humans)
	want := []window{{0, 220}, {340, 480}, {840, 990}}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestRenderRequest(t *testing.T) {
	cues := []vtt.Cue{
		{Start: 5, End: 9, Text: "привет"},
		{Start: 31, End: 35, Text: "спонсор выпуска"},
		{Start: 36, End: 40, Text: "переходите по ссылке"},
		{Start: 300, End: 304, Text: "далеко от всего"},
		{Start: 500, End: 504, Text: "подписывайтесь"},
	}
	s := Signals{Counters: Counters{Undo: 5, HumanMarkups: 1, ConflictingMarkups: 1}, ViewsMax: new(int64), Requests: 12, AgeH: 30}
	*s.ViewsMax = 25000
	s.humans = []humanNote{{humanInterval: humanInterval{3, 495, 510, 4}, Conflicting: true}}
	req := renderRequest(detector.Prompt{Text: "PROMPT"}, testVideo, s, testCategories, cues)
	if req.System != "PROMPT" || req.Key != "-1_456000001" || req.Schema != llmSchema {
		t.Fatalf("got %+v", req)
	}
	for _, want := range []string{
		`<video duration="600" published_hours_ago="30" requests="12" views="25000">`,
		"[0] sponsor 30-70 s: спонсор выпуска переходите по ссылке\n",
		"undo=5 (0.20 per 1k views)\n",
		"self_promotion 495-510 s, author rating 4, disagrees with the AI\n",
		"<transcript from=\"0\" to=\"130\">\n5.0-9.0: привет\n31.0-35.0: спонсор выпуска\n36.0-40.0: переходите по ссылке\n</transcript>\n",
		"<transcript from=\"435\" to=\"570\">\n500.0-504.0: подписывайтесь\n</transcript>\n",
	} {
		if !strings.Contains(req.User, want) {
			t.Errorf("missing %q in\n%s", want, req.User)
		}
	}
	if strings.Contains(req.User, "далеко от всего") {
		t.Error("a cue outside every window is not sent")
	}
}

func TestRenderRequestWithoutViews(t *testing.T) {
	zero := int64(0)
	for _, views := range []*int64{nil, &zero} {
		s := Signals{Counters: Counters{Undo: 5}, ViewsMax: views, Requests: 12, AgeH: 30}
		req := renderRequest(detector.Prompt{Text: "PROMPT"}, testVideo, s, testCategories, nil)
		if strings.Contains(req.User, "per 1k views") || !strings.Contains(req.User, "undo=5\n") {
			t.Errorf("views %v: no rates without views, got\n%s", views, req.User)
		}
		if hasViews := strings.Contains(req.User, ` views="`); hasViews != (views != nil) {
			t.Errorf("views %v: views attribute %v", views, hasViews)
		}
	}
}

func TestAnthropicJudge(t *testing.T) {
	var sent map[string]any
	stop := "end_turn"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &sent); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"id":"m","type":"message","role":"assistant","model":"m","stop_reason":"` + stop + `",
			"content":[{"type":"text","text":"{\"decision\":\"ok\"}"}],
			"usage":{"input_tokens":1200,"output_tokens":40,"cache_read_input_tokens":5,"cache_creation_input_tokens":7}}`))
	}))
	defer srv.Close()
	j := &anthropicJudge{client: anthropic.NewClient(option.WithAPIKey("test"), option.WithBaseURL(srv.URL), option.WithMaxRetries(0)), model: "claude-sonnet-5-5"}
	req := detector.Request{System: "PROMPT", User: "<video>", Schema: llmSchema}

	res, err := j.Judge(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	if res.Raw != `{"decision":"ok"}` || res.Usage != (detector.Usage{InputTokens: 1200, OutputTokens: 40, CacheReadTokens: 5, CacheWriteTokens: 7}) {
		t.Fatalf("got %+v", res)
	}
	format := sent["output_config"].(map[string]any)["format"].(map[string]any)
	if sent["model"] != "claude-sonnet-5-5" || sent["max_tokens"] != float64(llmMaxTokens) || format["type"] != "json_schema" ||
		format["schema"].(map[string]any)["required"] == nil {
		t.Fatalf("request %v", sent)
	}
	if sys := sent["system"].([]any)[0].(map[string]any); sys["text"] != "PROMPT" {
		t.Fatalf("system %v", sys)
	}

	// A cut-off answer is still returned (and paid): parseOutput makes it judge_invalid.
	stop = "max_tokens"
	if res, err = j.Judge(context.Background(), req); err != nil || res.Raw != `stop_reason max_tokens: {"decision":"ok"}` {
		t.Fatalf("got %+v %v", res, err)
	}
	if _, err := parseOutput(res.Raw, 0); err == nil {
		t.Fatal("a cut-off answer must not parse")
	}
}

// An entry an assessor moved is read with its source and marked, so the judge does not take a
// human-set edge for a detector error; the detector's own entries stay unmarked.
func TestRenderRequestMarksReviewSetBounds(t *testing.T) {
	entries, err := parseEntries([]byte(`[{"category_id":2,"start":30,"end":70,"confidence":"high","source":"ai"},
		{"category_id":3,"start":118,"end":150,"confidence":"high","source":"review"}]`))
	if err != nil || entries[0].Source != "ai" || entries[1].Source != "review" {
		t.Fatalf("got %+v %v", entries, err)
	}
	v := testVideo
	v.Entries = entries
	req := renderRequest(detector.Prompt{Text: "PROMPT"}, v, Signals{}, testCategories, []vtt.Cue{{Start: 120, End: 124, Text: "подписывайтесь"}})
	for _, want := range []string{"[0] sponsor 30-70 s: \n", "[1] self_promotion 118-150 s (bounds by review): подписывайтесь\n"} {
		if !strings.Contains(req.User, want) {
			t.Errorf("missing %q in\n%s", want, req.User)
		}
	}
}
