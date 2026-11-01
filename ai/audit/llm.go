package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"odedohbest/video-calculate/ai/detector"
)

// llmSchema is the audit's response format (structured output): the model adds comment / other
// findings and a summary, never the rule findings.
const llmSchema = `{
  "type": "object",
  "properties": {
    "summary": {"type": "string"},
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "kind":     {"type": "string", "enum": ["comment", "other"]},
          "severity": {"type": "string", "enum": ["owner", "backlog", "info"]},
          "items":    {"type": "array", "items": {"type": "string"}},
          "text":     {"type": "string"},
          "action": {
            "type": "object",
            "properties": {
              "type": {"type": "string", "enum": ["none", "blind_subset", "backlog_item", "eval_import", "reviewer_note"]},
              "note": {"type": "string"}
            },
            "required": ["type", "note"],
            "additionalProperties": false
          }
        },
        "required": ["kind", "severity", "items", "text", "action"],
        "additionalProperties": false
      }
    }
  },
  "required": ["summary", "findings"],
  "additionalProperties": false
}`

const (
	llmMaxTokens = 8192 // a 27-item batch's Russian findings ran out at 2048 (prod, 2026-11-01)
	cuesMax      = 600  // characters of an item's cues the model sees
	textMax      = 400  // characters kept of a model finding's text and of the summary
)

type llmResult struct {
	Raw   string
	Usage detector.Usage
}

// llmClient makes the audit's one call per batch: a transport error is a failed batch the
// next tick retries, a broken answer is recorded as llm_error.
type llmClient interface {
	Audit(ctx context.Context, req detector.Request) (llmResult, error)
	Model() string
}

func newLLMClient(cfg Config) (llmClient, error) {
	switch cfg.Client {
	case "anthropic", "messages":
		key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
		return &anthropicAudit{client: anthropic.NewClient(option.WithAPIKey(key)), model: cfg.Model}, nil
	case "fixture":
		return &fixtureAudit{dir: cfg.FixtureDir, model: cfg.Model}, nil
	}
	return nil, fmt.Errorf("AI_CLIENT must be anthropic, messages or fixture, got %q", cfg.Client)
}

// anthropicAudit calls the Messages API, as the judge does (ai/judge/llm.go).
type anthropicAudit struct {
	client anthropic.Client
	model  string
}

func (a *anthropicAudit) Model() string { return a.model }

func (a *anthropicAudit) Audit(ctx context.Context, req detector.Request) (llmResult, error) {
	var schema map[string]any
	if err := json.Unmarshal([]byte(req.Schema), &schema); err != nil {
		return llmResult{}, fmt.Errorf("schema: %w", err)
	}
	msg, err := a.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:        anthropic.Model(a.model),
		MaxTokens:    llmMaxTokens,
		System:       []anthropic.TextBlockParam{{Text: req.System}},
		Messages:     []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(req.User))},
		OutputConfig: anthropic.OutputConfigParam{Format: anthropic.JSONOutputFormatParam{Schema: schema}},
	})
	if err != nil {
		return llmResult{}, err
	}
	res := llmResult{Usage: detector.Usage{
		InputTokens:      int(msg.Usage.InputTokens),
		OutputTokens:     int(msg.Usage.OutputTokens),
		CacheReadTokens:  int(msg.Usage.CacheReadInputTokens),
		CacheWriteTokens: int(msg.Usage.CacheCreationInputTokens),
	}}
	var text strings.Builder
	for _, block := range msg.Content {
		if t, ok := block.AsAny().(anthropic.TextBlock); ok {
			text.WriteString(t.Text)
		}
	}
	res.Raw = text.String()
	if msg.StopReason != anthropic.StopReasonEndTurn {
		res.Raw = fmt.Sprintf("stop_reason %s: %s", msg.StopReason, res.Raw)
	}
	return res, nil
}

// fixtureAudit (AI_CLIENT=fixture) answers from <dir>/<batch>.audit.json.
type fixtureAudit struct{ dir, model string }

func (f *fixtureAudit) Model() string { return f.model }

func (f *fixtureAudit) Audit(_ context.Context, req detector.Request) (llmResult, error) {
	b, err := os.ReadFile(filepath.Join(f.dir, req.Key+".audit.json"))
	if err != nil {
		return llmResult{}, fmt.Errorf("fixture: %w", err)
	}
	return llmResult{Raw: string(b), Usage: detector.FixtureUsage}, nil
}

type requestVerdict struct {
	Reviewer string `json:"reviewer"`
	Verdict  string `json:"verdict"`
	Comment  string `json:"comment,omitempty"`
	Bounds   string `json:"bounds,omitempty"`
}

type requestItem struct {
	Code     string           `json:"code"`
	Proposed string           `json:"proposed"`
	Bounds   string           `json:"bounds"`
	Source   string           `json:"source"`
	Flagged  string           `json:"flagged_by,omitempty"`
	Cues     string           `json:"cues,omitempty"`
	Verdicts []requestVerdict `json:"verdicts"`
}

// renderRequest is the model's input: the batch, its metrics and rule findings, and per item
// what was proposed and every finisher's latest verdict with comment and bounds.
func renderRequest(prompt detector.Prompt, d *batchData, m map[string]any, rules []Finding) (detector.Request, error) {
	v := newView(d)
	items := make([]requestItem, 0, len(d.Items))
	for _, it := range d.Items {
		ri := requestItem{Code: it.Code, Proposed: it.Proposed, Bounds: playerRange(it.Start, it.End),
			Source: itemSource(it), Cues: cut(it.Cues, cuesMax)}
		if len(it.FlaggedBy) > 0 {
			ri.Flagged = it.FlaggedBy[0]
		}
		for _, rev := range sortedKeys(v.byRev) {
			x, ok := v.byRev[rev][it.ID]
			if !ok {
				continue
			}
			rv := requestVerdict{Reviewer: rev, Verdict: x.Verdict, Comment: x.Comment}
			if x.hasBounds() {
				rv.Bounds = playerRange(float64(x.Start.Int64), float64(x.End.Int64))
			}
			ri.Verdicts = append(ri.Verdicts, rv)
		}
		items = append(items, ri)
	}
	user, err := json.MarshalIndent(map[string]any{"batch": d.Batch, "metrics": m, "rule_findings": rules, "items": items}, "", " ")
	if err != nil {
		return detector.Request{}, err
	}
	return detector.Request{System: prompt.Text, User: string(user), Schema: llmSchema, Key: d.Batch}, nil
}

type llmOutput struct {
	Summary  string `json:"summary"`
	Findings []struct {
		Kind     string   `json:"kind"`
		Severity string   `json:"severity"`
		Items    []string `json:"items"`
		Text     string   `json:"text"`
		Action   Action   `json:"action"`
	} `json:"findings"`
}

// parseOutput decodes the answer and keeps the findings that name only item codes of the batch;
// dropped counts the rest. An error means the answer as a whole is unusable.
func parseOutput(raw string, d *batchData) (summary string, findings []Finding, dropped int, err error) {
	var out llmOutput
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		return "", nil, 0, fmt.Errorf("parse: %w", err)
	}
	codes := map[string]bool{}
	for _, it := range d.Items {
		codes[it.Code] = true
	}
	for _, f := range out.Findings {
		ok := (f.Kind == "comment" || f.Kind == "other") && len(f.Items) > 0 && strings.TrimSpace(f.Text) != ""
		switch f.Severity {
		case severityOwner, severityBacklog, severityInfo:
		default:
			ok = false
		}
		for _, c := range f.Items {
			ok = ok && codes[c]
		}
		if !ok {
			dropped++
			continue
		}
		if f.Action.Type == "" {
			f.Action.Type = "none"
		}
		findings = append(findings, Finding{Kind: f.Kind, Severity: f.Severity, Items: f.Items,
			Text: cut(strings.TrimSpace(f.Text), textMax), Action: f.Action})
	}
	return cut(strings.TrimSpace(out.Summary), textMax), findings, dropped, nil
}

func playerRange(start, end float64) string {
	return playerTime(start) + "–" + playerTime(end)
}

// playerTime is formatPlayerTime of lib/review-sheet.js: m:ss or h:mm:ss, rounded to the second.
func playerTime(seconds float64) string {
	t := int(math.Round(seconds))
	if t >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", t/3600, t%3600/60, t%60)
	}
	return fmt.Sprintf("%d:%02d", t/60, t%60)
}

// cut keeps at most n characters, on a rune boundary.
func cut(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}
