package pipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/review"
	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/vtt"
)

// confirmIoU asks "the same ad", not "the same edges" (the first model's edges are served):
// on the held-out set 0.5 vetoed 18 more true ads than 0.3 for 4 more wrong cuts (owner, 2026-10-31).
const confirmIoU = 0.3

// confirmation is the second model's opinion on one run (AI_SECOND_ENABLED).
// confirmed is parallel to detector.Resolve of the first answer; nil when the
// second call failed, and then nothing is gated.
type confirmation struct {
	model     string
	promptSHA string
	res       detector.Result
	cost      float64
	err       error
	confirmed []bool
	extra     int // second-model segments matching no first-model segment of their category
}

// confirm asks the second model about the same transcript, before finish takes
// the queue row's lock (the read path upserts that row on every request). nil
// when the switch is off or the first answer has nothing to confirm (a failed
// call or an invalid answer: the run fails as without the switch).
func (r *detectRun) confirm(ctx context.Context, nativeID string, meta transcript.Meta, cues []vtt.Cue, first detector.Result, firstErr error) *confirmation {
	units := requestFormat.Apply(cues)
	if r.second == nil || firstErr != nil || detector.Validate(units, first.Output) != nil {
		return nil
	}
	req := detector.NewRequestFormat(r.prompt, meta, units, requestFormat)
	req.Key = nativeID
	res, err := r.second.Detect(ctx, req)
	c := &confirmation{model: r.second.Model(), promptSHA: r.prompt.SHA, res: res, cost: r.secondPrice.Cost(res.Usage)}
	if err == nil {
		err = detector.Validate(units, res.Output)
	}
	if err != nil {
		c.err = err
		log.Printf("ai detect: %s second opinion failed: %s", nativeID, strings.ReplaceAll(err.Error(), "\n", ": "))
		return c
	}
	c.confirmed, c.extra = agree(detector.Resolve(units, first.Output), detector.Resolve(units, res.Output))
	return c
}

// agree marks each first-model prediction the second model found too: same
// category, IoU at least confirmIoU; extra counts the second's that match none.
func agree(first, second []detector.Prediction) ([]bool, int) {
	matches := func(a detector.Prediction, others []detector.Prediction) bool {
		for _, o := range others {
			if o.Category == a.Category && iou(a.Start, a.End, o.Start, o.End) >= confirmIoU {
				return true
			}
		}
		return false
	}
	confirmed := make([]bool, len(first))
	for i, p := range first {
		confirmed[i] = matches(p, second)
	}
	extra := 0
	for _, s := range second {
		if !matches(s, first) {
			extra++
		}
	}
	return confirmed, extra
}

func iou(aStart, aEnd, bStart, bEnd float64) float64 {
	inter := min(aEnd, bEnd) - max(aStart, bStart)
	union := max(aEnd, bEnd) - min(aStart, bStart)
	if inter <= 0 || union <= 0 {
		return 0
	}
	return inter / union
}

// gate is what entries() takes: nil (no gate) unless the second model answered.
func (c *confirmation) gate() []bool {
	if c == nil || c.err != nil {
		return nil
	}
	return c.confirmed
}

// record writes the confirmation row and sends every unconfirmed entry to
// review, in finish's transaction (lock order: queue row, video_calculateds,
// then a batch row, as the judge's AI row before its batch row).
func (r *detectRun) record(tx *sql.Tx, c *confirmation, runID int64, videoID int, nativeID string, data, hidden []Entry, cues []vtt.Cue, now time.Time) error {
	usage, err := json.Marshal(usageRow{c.res.Usage.InputTokens, c.res.Usage.OutputTokens, c.res.Usage.CacheReadTokens, c.res.Usage.CacheWriteTokens})
	if err != nil {
		return err
	}
	var unconfirmed []Entry
	for _, e := range hidden {
		if e.Reason == reasonUnconfirmed {
			unconfirmed = append(unconfirmed, e)
		}
	}
	var errText, confirmed, uncount, extra any
	if c.err != nil {
		errText = c.err.Error()
	} else {
		confirmed, uncount, extra = len(data), len(unconfirmed), c.extra
	}
	if _, err := tx.Exec(`INSERT INTO prv_ai_confirmations
			(run_id, video_id, native_id, model, prompt_sha, raw_output, usage, cost_usd, error, confirmed, unconfirmed, extra)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
		runID, videoID, nativeID, c.model, c.promptSHA, rawJSON(c.res.Raw), usage, c.cost, errText, confirmed, uncount, extra); err != nil {
		return fmt.Errorf("confirmation row: %w", err)
	}
	if len(unconfirmed) == 0 {
		return nil
	}
	names := map[int]string{}
	for name, id := range r.categories {
		names[id] = name
	}
	items := make([]review.Item, len(unconfirmed))
	for i, e := range unconfirmed {
		items[i] = review.Item{NativeID: nativeID, VideoID: videoID, Start: e.Start, End: e.End, Proposed: names[e.CategoryID],
			Cues: review.CueText(cues, float64(e.Start), float64(e.End), "\n"), Link: r.prv.LinkAt(nativeID, e.Start-2),
			FlaggedBy: []string{fmt.Sprintf("second %s: not found", c.model),
				fmt.Sprintf("entry: %s %s, %d s", names[e.CategoryID], e.Confidence, e.End-e.Start)}}
	}
	// important: above the below-threshold passes (optional), below the judge's served-row questions (urgent).
	if _, err := review.Add(tx, "ai-second-"+now.UTC().Format("2006-01-02"), "D", "important", items); err != nil {
		return fmt.Errorf("unconfirmed items: %w", err)
	}
	return nil
}
