package pipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/judge"
)

// sourceReview marks an entry whose bounds an assessor set (prv/repository/ai.js applyVerdict).
const sourceReview = "review"

// backlogMax is how many rows one tick confirms later: Haiku's p95 ~18 s keeps them
// within ~3 minutes of the 5-minute cron slot.
const backlogMax = 10

// backlogRule is a published row with no second opinion yet (deferred by the budget, or
// published with the switch off) that serves something (a later confirmation never adds
// an entry), of a detector of another vendor than the second model ($1: whether that is
// Anthropic), with a run its answer can be rebuilt from. A same-vendor pair (Sonnet → Haiku)
// vetoes true ads too often to run (eval stage 7).
const backlogRule = `FROM prv_ai_video_calculateds a JOIN prv_ai_runs r ON r.id = a.run_id
	WHERE a.withdrawn_at IS NULL AND a.data <> '[]' AND (r.model LIKE 'claude-%') <> $1
		AND jsonb_typeof(r.raw_output) = 'object' AND r.transcript IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM prv_ai_confirmations c WHERE c.run_id = a.run_id)`

type backlogRow struct {
	videoID  int
	nativeID string
	runID    int64
	raw      []byte
	tr       []byte
}

// confirmBacklog makes the second call for the backlog's newest rows while the second
// model's vendor has room today, then counts what is left. A failed row is logged and
// left as it is; err is a failure to read the backlog.
func (r *detectRun) confirmBacklog(ctx context.Context) (left int, err error) {
	secondAnthropic := vendorOf(r.second.Model()) == vendorAnthropic
	rows, err := r.db.Query(`SELECT a.video_id, a.native_id, a.run_id, r.raw_output, r.transcript `+backlogRule+`
		ORDER BY a.published_at DESC, a.video_id LIMIT `+fmt.Sprint(backlogMax), secondAnthropic)
	if err != nil {
		return 0, err
	}
	var todo []backlogRow
	for rows.Next() {
		var b backlogRow
		if err := rows.Scan(&b.videoID, &b.nativeID, &b.runID, &b.raw, &b.tr); err != nil {
			rows.Close()
			return 0, err
		}
		todo = append(todo, b)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, b := range todo {
		if !r.secondAllowed() {
			break
		}
		if err := r.confirmLater(ctx, b); err != nil {
			log.Printf("ai detect: %s confirm backlog failed: %s", b.nativeID, strings.ReplaceAll(err.Error(), "\n", ": "))
		}
	}
	err = r.db.QueryRow(`SELECT COUNT(*) `+backlogRule, secondAnthropic).Scan(&left)
	return left, err
}

// confirmLater is a later confirm(): the second call on the stored run's transcript with the
// current prompt, outside any lock, then one transaction that gates the row's served entries
// (lock order: publishLock, video_calculateds, the AI row, then a batch row in review.Add).
// A call with no answer writes nothing; an answer that does not validate writes its row with the error.
func (r *detectRun) confirmLater(ctx context.Context, b backlogRow) error {
	var st storedTranscript
	if err := json.Unmarshal(b.tr, &st); err != nil {
		return fmt.Errorf("run %d transcript: %w", b.runID, err)
	}
	units := requestFormat.Apply(st.Cues)
	first, err := detector.ParseOutput(string(b.raw))
	if err == nil {
		err = detector.Validate(units, first)
	}
	if err != nil {
		return fmt.Errorf("run %d answer: %w", b.runID, err)
	}
	res, err := r.askSecond(ctx, b.nativeID, st.Meta, units)
	if err != nil && res.Usage == (detector.Usage{}) {
		return err
	}
	c := &confirmation{model: r.second.Model(), promptSHA: r.prompt.SHA, res: res, cost: r.secondPrice.Cost(res.Usage)}
	if err == nil {
		err = detector.Validate(units, res.Output)
	}
	var preds []detector.Prediction
	if err != nil {
		c.err = err
	} else {
		preds = detector.Resolve(units, first)
		c.confirmed, c.extra = agree(preds, detector.Resolve(units, res.Output))
	}

	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(publishLock); err != nil {
		return fmt.Errorf("publish lock: %w", err)
	}
	if err := lockVideoCalculated(tx, b.videoID); err != nil {
		return err
	}
	var dataB, hiddenB []byte
	var runID int64
	var withdrawn sql.NullTime
	if err := tx.QueryRow(`SELECT data, hidden, run_id, withdrawn_at FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE`, b.videoID).
		Scan(&dataB, &hiddenB, &runID, &withdrawn); err != nil {
		return fmt.Errorf("lock AI row: %w", err)
	}
	if withdrawn.Valid || runID != b.runID {
		log.Printf("ai detect: %s withdrawn or re-published meanwhile, not confirmed", b.nativeID)
		return nil
	}
	var data, hidden []Entry
	if err := errors.Join(json.Unmarshal(dataB, &data), json.Unmarshal(hiddenB, &hidden)); err != nil {
		return err
	}
	var served, moved []Entry
	confirmed, unconfirmed, pinned := 0, 0, 0
	if c.err == nil {
		keeps, err := judge.EntryKeepsAll(tx, b.videoID, dataB)
		if err != nil {
			return fmt.Errorf("keep verdicts: %w", err)
		}
		served = []Entry{}
		for _, e := range data {
			i := r.prediction(e, preds)
			_, kept := keeps[judge.EntryKey{Start: e.Start, End: e.End}]
			switch {
			case i < 0:
			case c.confirmed[i]:
				confirmed++
			case kept || e.Source == sourceReview:
				unconfirmed++
				pinned++
			default:
				unconfirmed++
				e.Reason, e.Rating = reasonUnconfirmed, 0
				moved = append(moved, e)
				continue
			}
			served = append(served, e)
		}
	}
	if len(moved) > 0 {
		if dataB, err = json.Marshal(served); err != nil {
			return err
		}
		if hiddenB, err = json.Marshal(append(hidden, moved...)); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE prv_ai_video_calculateds SET data = $2, hidden = $3, updated_at = NOW() WHERE video_id = $1`,
			b.videoID, dataB, hiddenB); err != nil {
			return err
		}
	}
	if err := r.record(tx, c, b.runID, b.videoID, b.nativeID, confirmed, unconfirmed, moved, st.Cues, time.Now()); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if c.err != nil {
		log.Printf("ai detect: %s confirmed later: second opinion of %s invalid, row kept: %v", b.nativeID, c.model, c.err)
		return nil
	}
	log.Printf("ai detect: %s confirmed later by %s: %d confirmed, %d unconfirmed (%d kept by review), %d moved to hidden, $%.4f",
		b.nativeID, c.model, confirmed, unconfirmed, pinned, len(moved), c.cost)
	return nil
}

// prediction is the first-model prediction a served entry came from: of its category, with the
// largest overlap (a chapter or a verdict may have moved its bounds); -1 when none overlaps.
func (r *detectRun) prediction(e Entry, preds []detector.Prediction) int {
	best, bestOverlap := -1, 0.0
	for i, p := range preds {
		if r.categories[p.Category] != e.CategoryID {
			continue
		}
		if o := min(p.End, float64(e.End)) - max(p.Start, float64(e.Start)); o > bestOverlap {
			best, bestOverlap = i, o
		}
	}
	return best
}
