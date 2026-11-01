package audit

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"odedohbest/video-calculate/ai/detector"
)

func llmBatch() *batchData {
	its := aiItems("A", "judge review by llm: x", 2, "sponsor")
	its[0].Cues = strings.Repeat("я", 700)
	vs := verdicts("Gam", its, "sponsor", time.Minute, 1)
	vs[0].Comment = "ссылка не открывается"
	return &batchData{Batch: "ai-judge-2026-11-01", Finished: []string{"Gam"}, Items: its, Verdicts: vs}
}

func TestRenderRequest(t *testing.T) {
	d := llmBatch()
	req, err := renderRequest(detector.Prompt{Text: "audit"}, d, metrics(d), ruleFindings(d))
	if err != nil {
		t.Fatal(err)
	}
	if req.Key != d.Batch || req.System != "audit" || req.Schema != llmSchema {
		t.Fatalf("request = %+v", req)
	}
	var in struct {
		Items []requestItem `json:"items"`
	}
	if err := json.Unmarshal([]byte(req.User), &in); err != nil {
		t.Fatal(err)
	}
	if got := len([]rune(in.Items[0].Cues)); got != cuesMax+1 {
		t.Fatalf("cues cut to %d runes", got)
	}
	if in.Items[0].Bounds != "0:10–0:40" || in.Items[0].Verdicts[0].Comment != "ссылка не открывается" || in.Items[0].Source != sourceJudge {
		t.Fatalf("item = %+v", in.Items[0])
	}
	if err := json.Unmarshal([]byte(llmSchema), new(map[string]any)); err != nil {
		t.Fatalf("schema: %v", err)
	}
}

func TestParseOutput(t *testing.T) {
	d := llmBatch()
	raw := `{"summary":"Два подтверждения.","findings":[
		{"kind":"comment","severity":"owner","items":["A1"],"text":"Асессор пишет, что ссылка не открывается.","action":{"type":"none","note":""}},
		{"kind":"comment","severity":"owner","items":["Z9"],"text":"чужой код","action":{"type":"none","note":""}},
		{"kind":"other","severity":"info","items":[],"text":"без кодов","action":{"type":"none","note":""}},
		{"kind":"rubber_stamp","severity":"owner","items":["A1"],"text":"не его вид","action":{"type":"none","note":""}}]}`
	summary, fs, dropped, err := parseOutput(raw, d)
	if err != nil || summary != "Два подтверждения." || dropped != 3 || len(fs) != 1 || fs[0].Items[0] != "A1" || fs[0].Severity != severityOwner {
		t.Fatalf("summary %q, findings %+v, dropped %d, err %v", summary, fs, dropped, err)
	}
	if _, _, _, err := parseOutput(`stop_reason max_tokens: {"summary":`, d); err == nil {
		t.Fatal("a cut-off answer parsed")
	}
	if _, _, _, err := parseOutput(`{"summary":"","findings":[],"extra":1}`, d); err == nil {
		t.Fatal("an unknown field parsed")
	}
}

func TestFixtureClient(t *testing.T) {
	dir := t.TempDir()
	c, err := newLLMClient(Config{Client: "fixture", FixtureDir: dir, Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Audit(context.Background(), detector.Request{Key: "b1"}); err == nil {
		t.Fatal("a missing fixture answered")
	}
	os.WriteFile(filepath.Join(dir, "b1.audit.json"), []byte(`{"summary":"","findings":[]}`), 0o644)
	if res, err := c.Audit(context.Background(), detector.Request{Key: "b1"}); err != nil || res.Usage != detector.FixtureUsage {
		t.Fatalf("fixture: %+v %v", res, err)
	}
	if _, err := newLLMClient(Config{Client: "batch"}); err == nil {
		t.Fatal("an unknown client")
	}
}

func TestPlayerTime(t *testing.T) {
	for in, want := range map[float64]string{0: "0:00", 59.6: "1:00", 754: "12:34", 3723: "1:02:03"} {
		if got := playerTime(in); got != want {
			t.Errorf("playerTime(%v) = %s, want %s", in, got, want)
		}
	}
}
