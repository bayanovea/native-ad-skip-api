// Package detector turns one transcript into ad segments with one model call.
//
// It is the only package that will also run inside the product, so it depends
// on nothing but the transcript format: no store, no eval sets, no run
// directories. The model boundary is the Client interface; the Anthropic
// implementation lives in anthropic.go, everything else here is pure.
package detector

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/vtt"
)

// Categories the detector may return. intro/credits exist in the product but
// have no transcript signal (music, no words), so v0 does not ask for them.
const (
	CategorySponsor       = "sponsor"
	CategorySelfPromotion = "self_promotion"
)

// Segment is one detected segment as the model returns it: cue indices, not
// seconds. The model never writes a timestamp; Resolve maps indices to the
// cue times, so a segment can only start and end where the transcript has
// text. That is the "inner boundary" rule from the prompt, enforced by shape.
type Segment struct {
	Category   string `json:"category"`
	FirstCue   int    `json:"first_cue"`
	LastCue    int    `json:"last_cue"`
	Confidence string `json:"confidence"` // high | medium | low: a ranking signal, not a probability
	Quote      string `json:"quote"`      // first words of the first cue, for alignment checks
}

// Output is the whole model response; the schema below enforces its shape.
type Output struct {
	Segments []Segment `json:"segments"`
}

// Schema is the JSON schema sent as the response format (structured output).
// The API guarantees the response matches it, so the prompt explains the
// meaning of the fields and never their types.
const Schema = `{
  "type": "object",
  "properties": {
    "segments": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "category":   {"type": "string", "enum": ["sponsor", "self_promotion"]},
          "first_cue":  {"type": "integer"},
          "last_cue":   {"type": "integer"},
          "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
          "quote":      {"type": "string"}
        },
        "required": ["category", "first_cue", "last_cue", "confidence", "quote"],
        "additionalProperties": false
      }
    }
  },
  "required": ["segments"],
  "additionalProperties": false
}`

// Prompt is a versioned prompt file. Version comes from the file name
// (prompts/v1.md -> "v1"); SHA pins the exact text a run used.
type Prompt struct {
	Version string
	SHA     string // hex sha256 of Text
	Text    string
}

// LoadPrompt reads a prompt file and derives its version and hash.
func LoadPrompt(path string) (Prompt, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Prompt{}, err
	}
	sum := sha256.Sum256(b)
	return Prompt{
		Version: strings.TrimSuffix(filepath.Base(path), filepath.Ext(path)),
		SHA:     hex.EncodeToString(sum[:]),
		Text:    string(b),
	}, nil
}

// Request is one model call: the prompt as the system text, the rendered
// transcript as the user message. Schema is always Schema; it is a field so a
// client implementation does not need to know about this package's constants.
type Request struct {
	System string
	User   string
	Schema string
	// Key identifies the request to a client that answers in bulk (the batch
	// client matches results by it). Single-call clients ignore it.
	Key string
}

// Usage is what the API reports for one call. Cache fields are zero for a
// model or client that does not report them.
type Usage struct {
	InputTokens      int
	OutputTokens     int
	CacheReadTokens  int
	CacheWriteTokens int
}

// Result is one call's outcome. Raw keeps the response text for debugging a
// schema or validation failure; it is never persisted into the repository.
type Result struct {
	Output  Output
	Usage   Usage
	Latency time.Duration
	Raw     string
}

// Client makes one model call. Implementations must be safe for concurrent
// use; the CLI decides the parallelism.
type Client interface {
	// Detect sends the request and parses the structured response. It
	// returns an error for transport, API and schema failures; validation
	// of indices against the transcript is the caller's job (Validate).
	Detect(ctx context.Context, req Request) (Result, error)
	// Model returns the exact model id used, for run metadata.
	Model() string
}

// Format is how a transcript is shown to the model. The zero value is the v1
// format: every cue on its own line with times. The other settings are cost
// levers, each measured as its own run before it becomes a default.
type Format struct {
	NoTimes       bool    // omit cue times (the model returns indices and never uses them)
	WindowSeconds float64 // merge consecutive cues into windows of at least this many seconds; 0 = off
}

// Apply returns the units the model sees. With windows, one "cue" is a merged
// window: indices, Validate and Resolve all work on the returned slice, so a
// segment can only start and end on a window edge.
func (f Format) Apply(cues []vtt.Cue) []vtt.Cue {
	if f.WindowSeconds <= 0 || len(cues) == 0 {
		return cues
	}
	var out []vtt.Cue
	cur := vtt.Cue{Start: cues[0].Start, End: cues[0].End, Text: cues[0].Text}
	for _, c := range cues[1:] {
		if cur.End-cur.Start >= f.WindowSeconds {
			out = append(out, cur)
			cur = vtt.Cue{Start: c.Start, End: c.End, Text: c.Text}
			continue
		}
		cur.End = c.End
		cur.Text += " " + c.Text
	}
	return append(out, cur)
}

// NewRequest renders a transcript into the user message in the v1 format.
func NewRequest(p Prompt, meta transcript.Meta, cues []vtt.Cue) Request {
	return NewRequestFormat(p, meta, cues, Format{})
}

// NewRequestFormat renders cues (already passed through Format.Apply) into the
// user message. Times are printed with one decimal: enough to locate a cue.
func NewRequestFormat(p Prompt, meta transcript.Meta, cues []vtt.Cue, f Format) Request {
	var b strings.Builder
	fmt.Fprintf(&b, "<transcript lang=%q duration=%q>\n", meta.Lang, fmt.Sprintf("%.0f", meta.Duration))
	for i, c := range cues {
		if f.NoTimes {
			fmt.Fprintf(&b, "[%d] %s\n", i, c.Text)
		} else {
			fmt.Fprintf(&b, "[%d] %.1f-%.1f: %s\n", i, c.Start, c.End, c.Text)
		}
	}
	b.WriteString("</transcript>\n")
	return Request{System: p.Text, User: b.String(), Schema: Schema}
}

// Prediction is a segment resolved to seconds, the unit the scorer and the
// product work in. Cue indices are kept for error analysis.
type Prediction struct {
	Segment
	Start, End float64
}

// Validate checks a model output against the transcript it was made from.
// A failure here means the model broke the contract (an index outside the
// transcript, a reversed or overlapping segment); the caller records the
// video as failed rather than repairing the output, so the failure rate is
// itself a number in the run metrics.
func Validate(cues []vtt.Cue, out Output) error {
	segs := append([]Segment(nil), out.Segments...)
	sort.SliceStable(segs, func(i, j int) bool { return segs[i].FirstCue < segs[j].FirstCue })
	prevLast := -1
	for i, s := range segs {
		switch {
		case s.FirstCue < 0 || s.FirstCue >= len(cues):
			return fmt.Errorf("segment %d: first_cue %d outside 0..%d", i, s.FirstCue, len(cues)-1)
		case s.LastCue < 0 || s.LastCue >= len(cues):
			return fmt.Errorf("segment %d: last_cue %d outside 0..%d", i, s.LastCue, len(cues)-1)
		case s.LastCue < s.FirstCue:
			return fmt.Errorf("segment %d: last_cue %d before first_cue %d", i, s.LastCue, s.FirstCue)
		case s.FirstCue <= prevLast:
			return fmt.Errorf("segment %d: first_cue %d overlaps previous segment ending at cue %d", i, s.FirstCue, prevLast)
		case s.Category != CategorySponsor && s.Category != CategorySelfPromotion:
			return fmt.Errorf("segment %d: unknown category %q", i, s.Category)
		}
		prevLast = s.LastCue
	}
	return nil
}

// QuoteMatches reports whether the quote is a prefix of the first cue's text,
// ignoring case and surrounding spaces. A mismatch is a warning, not an
// error: the segment can still be right, but it is worth a look.
func QuoteMatches(cues []vtt.Cue, s Segment) bool {
	if s.FirstCue < 0 || s.FirstCue >= len(cues) {
		return false
	}
	q := strings.ToLower(strings.TrimSpace(s.Quote))
	t := strings.ToLower(strings.TrimSpace(cues[s.FirstCue].Text))
	if q == "" {
		return false
	}
	if len(q) > len(t) {
		q, t = t, q // the model may quote across two cues; accept the cue as a prefix of the quote
	}
	return strings.HasPrefix(t, q)
}

// Resolve maps validated segments to seconds, sorted by start.
func Resolve(cues []vtt.Cue, out Output) []Prediction {
	preds := make([]Prediction, 0, len(out.Segments))
	for _, s := range out.Segments {
		preds = append(preds, Prediction{Segment: s, Start: cues[s.FirstCue].Start, End: cues[s.LastCue].End})
	}
	sort.SliceStable(preds, func(i, j int) bool { return preds[i].Start < preds[j].Start })
	return preds
}

// ParseOutput decodes a structured response. The API enforces the schema, so
// a decode error means the client returned something other than the JSON
// content block.
func ParseOutput(raw string) (Output, error) {
	var out Output
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		return out, fmt.Errorf("parse output: %w", err)
	}
	return out, nil
}
