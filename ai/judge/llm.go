package judge

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/vtt"
)

// llmSchema is the judge's response format (structured output).
const llmSchema = `{
  "type": "object",
  "properties": {
    "decision": {"type": "string", "enum": ["ok", "withdraw", "review"]},
    "reason":   {"type": "string"},
    "segments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {"type": "integer"},
          "keep":  {"type": "boolean"}
        },
        "required": ["index", "keep"],
        "additionalProperties": false
      }
    }
  },
  "required": ["decision", "reason", "segments"],
  "additionalProperties": false
}`

// contextSeconds is how much transcript the judge sees on each side of a disagreement.
const contextSeconds = 60

// llmMaxTokens bounds the reply: a decision, one sentence and a keep flag per entry.
const llmMaxTokens = 2048

type llmOutput struct {
	Decision string       `json:"decision"`
	Reason   string       `json:"reason"`
	Segments []segmentOut `json:"segments"`
}

type segmentOut struct {
	Index int  `json:"index"`
	Keep  bool `json:"keep"`
}

type llmResult struct {
	Raw   string
	Usage detector.Usage
}

// llmClient makes the judge's one call per video; parsing is the caller's, so a
// broken answer from any client is judge_invalid, while an error here is a failed
// call the next tick retries.
type llmClient interface {
	Judge(ctx context.Context, req detector.Request) (llmResult, error)
	Model() string
}

func newLLMClient(kind, model, fixtureDir string) (llmClient, error) {
	switch kind {
	case "anthropic", "messages":
		key := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY"))
		if key == "" {
			return nil, errors.New("ANTHROPIC_API_KEY is not set")
		}
		return &anthropicJudge{client: anthropic.NewClient(option.WithAPIKey(key)), model: model}, nil
	case "fixture":
		return &fixtureJudge{dir: fixtureDir, model: model}, nil
	}
	return nil, fmt.Errorf("AI_CLIENT must be anthropic, messages or fixture, got %q", kind)
}

// anthropicJudge calls the Messages API: the judge needs an answer within the
// tick, and its calls are few, so the batch discount is not worth the latency.
type anthropicJudge struct {
	client anthropic.Client
	model  string
}

func (a *anthropicJudge) Model() string { return a.model }

func (a *anthropicJudge) Judge(ctx context.Context, req detector.Request) (llmResult, error) {
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
		// A cut-off or a refusal is still a paid answer: it goes to a human as judge_invalid.
		res.Raw = fmt.Sprintf("stop_reason %s: %s", msg.StopReason, res.Raw)
	}
	return res, nil
}

// fixtureJudge (AI_CLIENT=fixture) answers from <dir>/<native_id>.judge.json.
type fixtureJudge struct{ dir, model string }

func (f *fixtureJudge) Model() string { return f.model }

func (f *fixtureJudge) Judge(_ context.Context, req detector.Request) (llmResult, error) {
	b, err := os.ReadFile(filepath.Join(f.dir, req.Key+".judge.json"))
	if err != nil {
		return llmResult{}, fmt.Errorf("fixture: %w", err)
	}
	return llmResult{Raw: string(b)}, nil
}

// parseOutput decodes and checks the answer against the video's entries; any
// failure makes the judgement judge_invalid.
func parseOutput(raw string, entries int) (llmOutput, error) {
	var out llmOutput
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		return out, fmt.Errorf("parse: %w", err)
	}
	switch out.Decision {
	case decisionOK, decisionWithdraw, decisionReview:
	default:
		return out, fmt.Errorf("unknown decision %q", out.Decision)
	}
	if strings.TrimSpace(out.Reason) == "" {
		return out, errors.New("empty reason")
	}
	seen := map[int]bool{}
	for _, s := range out.Segments {
		if s.Index < 0 || s.Index >= entries {
			return out, fmt.Errorf("segment index %d outside 0..%d", s.Index, entries-1)
		}
		if seen[s.Index] {
			return out, fmt.Errorf("segment index %d twice", s.Index)
		}
		seen[s.Index] = true
	}
	return out, nil
}

type window struct{ From, To float64 }

// disagreementWindows are the AI entries and the conflicting human intervals,
// each widened by contextSeconds and merged where they overlap.
func disagreementWindows(entries []Entry, humans []humanNote) []window {
	var ws []window
	for _, e := range entries {
		ws = append(ws, window{float64(e.Start) - contextSeconds, float64(e.End) + contextSeconds})
	}
	for _, h := range humans {
		if h.Conflicting {
			ws = append(ws, window{h.Start - contextSeconds, h.End + contextSeconds})
		}
	}
	sort.Slice(ws, func(i, j int) bool { return ws[i].From < ws[j].From })
	var out []window
	for _, w := range ws {
		w.From = max(w.From, 0)
		if n := len(out); n > 0 && w.From <= out[n-1].To {
			out[n-1].To = max(out[n-1].To, w.To)
			continue
		}
		out = append(out, w)
	}
	return out
}

// renderRequest is the user message: the AI entries with their text, the
// counters (per 1k views when views are known), the human intervals and the
// transcript around every disagreement.
func renderRequest(p detector.Prompt, v Video, s Signals, categories map[int]string, cues []vtt.Cue) detector.Request {
	var b strings.Builder
	fmt.Fprintf(&b, "<video duration=%q published_hours_ago=\"%.0f\" requests=\"%d\"", fmt.Sprint(v.Duration.Int64), s.AgeH, s.Requests)
	if s.ViewsMax != nil {
		fmt.Fprintf(&b, " views=\"%d\"", *s.ViewsMax)
	}
	b.WriteString(">\n<ai_segments>\n")
	for i, e := range v.Entries {
		fmt.Fprintf(&b, "[%d] %s %d-%d s: %s\n", i, categories[e.CategoryID], e.Start, e.End, cueText(cues, float64(e.Start), float64(e.End), " "))
	}
	b.WriteString("</ai_segments>\n<signals>\n")
	c := s.Counters
	for _, x := range []struct {
		name string
		n    int
	}{{"votes_up", c.VotesUp}, {"votes_down", c.VotesDown}, {"undo", c.Undo}, {"clicks", c.Clicks},
		{"human_markups", c.HumanMarkups}, {"conflicting_markups", c.ConflictingMarkups}, {"duration_variants", c.DurationVariants}} {
		fmt.Fprintf(&b, "%s=%d", x.name, x.n)
		if s.ViewsMax != nil && *s.ViewsMax > 0 {
			fmt.Fprintf(&b, " (%.2f per 1k views)", float64(x.n)*1000/float64(*s.ViewsMax))
		}
		b.WriteString("\n")
	}
	b.WriteString("</signals>\n<human_intervals>\n")
	for _, h := range s.humans {
		fmt.Fprintf(&b, "%s %.0f-%.0f s, author rating %d", categories[h.CategoryID], h.Start, h.End, h.AuthorRating)
		if h.Conflicting {
			b.WriteString(", disagrees with the AI")
		}
		b.WriteString("\n")
	}
	b.WriteString("</human_intervals>\n")
	for _, w := range disagreementWindows(v.Entries, s.humans) {
		fmt.Fprintf(&b, "<transcript from=\"%.0f\" to=\"%.0f\">\n", w.From, w.To)
		for _, c := range cues {
			if c.End > w.From && c.Start < w.To {
				fmt.Fprintf(&b, "%.1f-%.1f: %s\n", c.Start, c.End, c.Text)
			}
		}
		b.WriteString("</transcript>\n")
	}
	b.WriteString("</video>\n")
	return detector.Request{System: p.Text, User: b.String(), Schema: llmSchema, Key: v.NativeID}
}

// cueText joins the text of the cues inside [from, to].
func cueText(cues []vtt.Cue, from, to float64, sep string) string {
	var parts []string
	for _, c := range cues {
		if c.End > from && c.Start < to {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, sep)
}

// runCues reads the transcript the AI row was detected from (prv_ai_runs).
func runCues(db *sql.DB, videoID int) ([]vtt.Cue, error) {
	var raw []byte
	if err := db.QueryRow(`SELECT r.transcript FROM prv_ai_video_calculateds a JOIN prv_ai_runs r ON r.id = a.run_id
		WHERE a.video_id = $1`, videoID).Scan(&raw); err != nil {
		return nil, fmt.Errorf("transcript: %w", err)
	}
	var t struct {
		Cues []vtt.Cue `json:"cues"`
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("transcript: %w", err)
	}
	return t.Cues, nil
}
