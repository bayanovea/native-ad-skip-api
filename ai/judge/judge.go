package judge

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/vtt"
	"odedohbest/video-calculate/calculator"
)

// Config is the judge's environment. Every switch defaults off, except the
// auto withdraw, which has no effect while the judge is off.
type Config struct {
	Enabled      bool          // AI_JUDGE_ENABLED=on
	AutoWithdraw bool          // AI_JUDGE_AUTO_WITHDRAW, on unless "off": an LLM withdraw unpublishes at once
	Model        string        // AI_JUDGE_MODEL
	MinInterval  time.Duration // AI_JUDGE_MIN_INTERVAL: at most one LLM call per video per interval
	Client       string        // AI_CLIENT: anthropic | messages (both the Messages API here) | fixture
	FixtureDir   string        // AI_FIXTURE_DIR: <native_id>.judge.json for AI_CLIENT=fixture
	PromptPath   string        // AI_JUDGE_PROMPT
}

func ConfigFromEnv() (Config, error) {
	c := Config{
		Enabled:      os.Getenv("AI_JUDGE_ENABLED") == "on",
		AutoWithdraw: os.Getenv("AI_JUDGE_AUTO_WITHDRAW") != "off",
		Model:        env("AI_JUDGE_MODEL", "claude-sonnet-5-5"),
		MinInterval:  6 * time.Hour,
		Client:       env("AI_CLIENT", "anthropic"),
		FixtureDir:   env("AI_FIXTURE_DIR", "/app/test/fixtures/ai"),
		PromptPath:   env("AI_JUDGE_PROMPT", "/app/ai/prompts/judge-v1.md"),
	}
	if s := os.Getenv("AI_JUDGE_MIN_INTERVAL"); s != "" {
		d, err := time.ParseDuration(s)
		if err != nil || d < 0 {
			return c, fmt.Errorf("AI_JUDGE_MIN_INTERVAL must be a non-negative duration like 6h, got %q", s)
		}
		c.MinInterval = d
	}
	return c, nil
}

func env(name, def string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return def
}

// commitSettle outlasts the signal writes' transactions (votes, undo events, markups: milliseconds).
const commitSettle = time.Second

// run is one tick's state.
type run struct {
	cfg        Config
	db         *sql.DB
	categories map[int]string
	llm        llmClient
	prompt     detector.Prompt
	price      detector.Price
	now        time.Time
}

// Run is one cron tick: every due published row through signals, rules and,
// when the rules do not decide, the LLM judge; one prv_ai_judgements row each,
// then the ai_judge heartbeat. Switched off, it only clears that heartbeat.
func Run(cfg Config) error {
	if !cfg.Enabled {
		db := calculator.ConnectDb()
		defer db.Close()
		return calculator.ClearHeartbeat(db, "ai_judge")
	}
	r := &run{cfg: cfg, now: time.Now()}
	var err error
	if r.llm, err = newLLMClient(cfg.Client, cfg.Model, cfg.FixtureDir); err != nil {
		return err
	}
	if r.prompt, err = detector.LoadPrompt(cfg.PromptPath); err != nil {
		return err
	}
	var priced bool
	if r.price, priced = detector.Prices[cfg.Model]; !priced {
		log.Printf("ai judge: no price for %s, cost recorded as 0", cfg.Model)
	}
	r.db = calculator.ConnectDb()
	defer r.db.Close()
	if r.categories, err = loadCategories(r.db); err != nil {
		return err
	}
	// Signals are counted up to r.now and the next tick takes what came after, by "createdAt",
	// which the writer sets after its last lock wait, just before its commit: waiting lets a write stamped before r.now commit
	// first, so the tick never misses one that the next tick would then call old.
	time.Sleep(commitSettle)
	// A failed video (an API error, say) is retried next tick and fires CalculatorFailedVideos;
	// the success, which CalculatorStale watches, needs only the tick's own query.
	failed, err := r.tick()
	if err != nil {
		log.Printf("ai judge: %v", err)
	}
	if err := calculator.WriteHeartbeatStatus(r.db, "ai_judge", failed, err == nil); err != nil {
		log.Printf("Heartbeat write failed: %v", err)
		return fmt.Errorf("heartbeat: %w", err)
	}
	if err != nil || failed > 0 {
		return fmt.Errorf("tick incomplete: %d videos failed", failed)
	}
	return nil
}

func (r *run) tick() (failed int, err error) {
	videos, err := dueVideos(r.db)
	if err != nil {
		return 0, err
	}
	for _, v := range videos {
		if err := r.judgeVideo(v); err != nil {
			log.Printf("ai judge: %d failed: %v", v.VideoID, err)
			failed++
		}
	}
	return failed, nil
}

// dueVideos lists the published non-empty rows that were judged before (judgeVideo
// skips them unless there is new evidence, or humans kept every entry since) or were
// published 24 h ago, so a first judgement sees a day of signals.
func dueVideos(db *sql.DB) ([]Video, error) {
	rows, err := db.Query(`SELECT a.video_id, a.native_id, a.data, a.published_at, v.duration,
			av.judged_at, av.judge_counters, av.views_max, av.requests, av.last_seen_at
		FROM prv_ai_video_calculateds a
		JOIN videos v ON v.id = a.video_id
		JOIN prv_ai_videos av ON av.native_id = a.native_id
		WHERE a.withdrawn_at IS NULL AND jsonb_array_length(a.data) > 0
			AND (av.judged_at IS NOT NULL OR a.published_at <= NOW() - INTERVAL '24 hours')
		ORDER BY a.video_id`)
	if err != nil {
		return nil, fmt.Errorf("due videos: %w", err)
	}
	defer rows.Close()
	var out []Video
	for rows.Next() {
		var v Video
		if err := rows.Scan(&v.VideoID, &v.NativeID, &v.Data, &v.PublishedAt, &v.Duration,
			&v.JudgedAt, &v.JudgeCounters, &v.ViewsMax, &v.Requests, &v.LastSeenAt); err != nil {
			return nil, fmt.Errorf("due videos: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// judgement is what one tick decides for a video.
type judgement struct {
	Decision, By, Reason string
	Model                string       // the LLM's, "" when no call was made
	Cost                 float64      // USD of the call
	Keep                 map[int]bool // entry index → the LLM's keep
	WithdrawBy           string       // prv_ai_video_calculateds.withdrawn_by, "" to keep the row served
	Review               bool         // send the entries to /admin/review
}

func (r *run) judgeVideo(v Video) error {
	var err error
	if v.Entries, err = parseEntries(v.Data); err != nil {
		return fmt.Errorf("data: %w", err)
	}
	// Each entry's baseline: evidence on it created after it is new; zero for a first judgement.
	since := make([]time.Time, len(v.Entries))
	allKept := false
	if v.JudgedAt.Valid {
		keeps, err := entryKeeps(r.db, v)
		if err != nil {
			return err
		}
		allKept = true
		for i, e := range v.Entries {
			since[i] = v.JudgedAt.Time
			if at, ok := keeps[[2]int{e.Start, e.End}]; ok {
				since[i] = at // humans have the last word: what they saw before their verdict is not new
			} else {
				allKept = false
			}
		}
	}
	s, err := collectSignals(r.db, v, r.categories, since, r.now)
	if err != nil {
		return err
	}
	if v.JudgedAt.Valid && !s.New.negative() && s.New.DurationRecut == 0 {
		if !allKept {
			return nil
		}
		// Recording it moves judged_at past the verdicts, so the next tick skips the video.
		return r.record(v, s, judgement{Decision: decisionOK, By: "rules", Reason: "every entry kept on review since the last judgement"}, nil)
	}
	decision, reason := rules(s)
	j := judgement{Decision: decision, By: "rules", Reason: reason, Review: decision == decisionReview}
	var cues []vtt.Cue
	if decision == needsLLM {
		if v.JudgedAt.Valid && r.now.Sub(v.JudgedAt.Time) < r.cfg.MinInterval {
			return nil // judged_at stays, so the evidence is still new after the interval
		}
		if cues, err = runCues(r.db, v.VideoID); err != nil {
			return err
		}
		if j, err = r.askLLM(v, s, cues); err != nil {
			return err
		}
		// A re-cut that came with the negative signals still reaches a human, whatever the LLM says.
		j.Review = j.Review || s.New.DurationRecut > 0
	}
	if j.Review && cues == nil {
		if cues, err = runCues(r.db, v.VideoID); err != nil {
			return err
		}
	}
	return r.record(v, s, j, cues)
}

// askLLM makes the judge's call. A transport or API error fails the video (the
// next tick retries); an answer that does not parse goes to a human as a review
// by rules with reason judge_invalid.
func (r *run) askLLM(v Video, s Signals, cues []vtt.Cue) (judgement, error) {
	res, err := r.llm.Judge(context.Background(), renderRequest(r.prompt, v, s, r.categories, cues))
	if err != nil {
		return judgement{}, fmt.Errorf("llm: %w", err)
	}
	j := judgement{Model: r.llm.Model(), Cost: r.price.Cost(res.Usage)}
	out, err := parseOutput(res.Raw, len(v.Entries))
	if err != nil {
		j.Decision, j.By, j.Reason, j.Review = decisionReview, "rules", "judge_invalid: "+err.Error(), true
		return j, nil
	}
	j.Decision, j.By, j.Reason = out.Decision, "llm", out.Reason
	j.Keep = map[int]bool{}
	for _, seg := range out.Segments {
		j.Keep[seg.Index] = seg.Keep
	}
	j.Review = out.Decision != decisionOK
	if out.Decision == decisionWithdraw && r.cfg.AutoWithdraw {
		j.WithdrawBy = "judge"
	}
	return j, nil
}

// record writes the judgement under the AI row's lock, withdraws, creates the
// review items, and moves judged_at to the tick's start (what the signals were
// counted up to, so evidence created during the tick is new next time) with the
// counters for the record. A row withdrawn meanwhile is left alone.
func (r *run) record(v Video, s Signals, j judgement, cues []vtt.Cue) error {
	signals, err := json.Marshal(s)
	if err != nil {
		return err
	}
	counters, err := json.Marshal(s.Counters)
	if err != nil {
		return err
	}
	var model, cost any
	if j.Model != "" {
		model, cost = j.Model, j.Cost
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var withdrawn sql.NullTime
	if err := tx.QueryRow(`SELECT withdrawn_at FROM prv_ai_video_calculateds WHERE video_id = $1 FOR UPDATE`, v.VideoID).Scan(&withdrawn); err != nil {
		return err
	}
	if withdrawn.Valid {
		return nil
	}
	if _, err := tx.Exec(`INSERT INTO prv_ai_judgements (video_id, decision, "by", reason, signals, model, cost_usd) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		v.VideoID, j.Decision, j.By, j.Reason, signals, model, cost); err != nil {
		return err
	}
	if j.WithdrawBy != "" {
		if _, err := tx.Exec(`UPDATE prv_ai_video_calculateds SET withdrawn_at = NOW(), withdrawn_by = $2, withdrawn_reason = $3, updated_at = NOW()
			WHERE video_id = $1`, v.VideoID, j.WithdrawBy, j.Reason); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'withdrawn' WHERE native_id = $1`, v.NativeID); err != nil {
			return err
		}
	}
	if j.Review {
		batch, n, err := addReviewItems(tx, v, j, s, cues, r.categories, r.now)
		if err != nil {
			return err
		}
		if n == 0 {
			log.Printf("ai judge: %d already waits for a review verdict on every entry, no new items", v.VideoID)
		} else {
			log.Printf("ai judge: %d sent %d items to review batch %s", v.VideoID, n, batch)
		}
	}
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET judged_at = $3, judge_counters = $2, updated_at = NOW() WHERE native_id = $1`,
		v.NativeID, counters, r.now); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("ai judge: %d %s %s: %s", v.VideoID, j.Decision, j.By, j.Reason)
	return nil
}

func loadCategories(db *sql.DB) (map[int]string, error) {
	rows, err := db.Query(`SELECT id, category FROM markup_categories`)
	if err != nil {
		return nil, fmt.Errorf("markup categories: %w", err)
	}
	defer rows.Close()
	m := map[int]string{}
	for rows.Next() {
		var id int
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		m[id] = name
	}
	return m, rows.Err()
}
