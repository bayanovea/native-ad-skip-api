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
// then the ai_judge heartbeat.
func Run(cfg Config) error {
	if !cfg.Enabled {
		return nil
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
	failed, err := r.tick()
	if err != nil {
		log.Printf("ai judge: %v", err)
		failed++
	}
	if err := calculator.WriteHeartbeat(r.db, "ai_judge", failed); err != nil {
		log.Printf("Heartbeat write failed: %v", err)
		return fmt.Errorf("heartbeat: %w", err)
	}
	if failed > 0 {
		return fmt.Errorf("%d videos failed", failed)
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
// skips them unless their counters moved) or were published 24 h ago, so a first
// judgement sees a day of signals.
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
	s, err := collectSignals(r.db, v, r.categories, r.now)
	if err != nil {
		return err
	}
	if v.JudgedAt.Valid && !moved(v.JudgeCounters, s.Counters) {
		return nil
	}
	decision, reason := rules(s)
	j := judgement{Decision: decision, By: "rules", Reason: reason}
	var cues []vtt.Cue
	switch decision {
	case decisionWithdraw:
		// The only rule withdraw is a re-cut, a fact rather than an opinion, so AI_JUDGE_AUTO_WITHDRAW does not
		// gate it, and no human is asked: a verdict on the old cut's timing would put it back.
		j.WithdrawBy = "duration"
	case needsLLM:
		if v.JudgedAt.Valid && r.now.Sub(v.JudgedAt.Time) < r.cfg.MinInterval {
			return nil // the stored counters stay, so the video is due again after the interval
		}
		if cues, err = runCues(r.db, v.VideoID); err != nil {
			return err
		}
		if j, err = r.askLLM(v, s, cues); err != nil {
			return err
		}
	}
	if err := r.record(v, s, j, cues); err != nil {
		return err
	}
	log.Printf("ai judge: %d %s %s: %s", v.VideoID, j.Decision, j.By, j.Reason)
	return nil
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

// record writes the judgement under the AI row's lock (the vote handler's order:
// AI row first), withdraws, creates the review items, and stores the counters the
// next tick compares against. A row withdrawn meanwhile is left alone.
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
		batch, err := addReviewItems(tx, v, j, s, cues, r.categories, r.now)
		if err != nil {
			return err
		}
		if batch == "" {
			log.Printf("ai judge: %d already waits for a review verdict, no new items", v.VideoID)
		} else {
			log.Printf("ai judge: %d sent %d items to review batch %s", v.VideoID, len(v.Entries), batch)
		}
	}
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET judged_at = NOW(), judge_counters = $2, updated_at = NOW() WHERE native_id = $1`,
		v.NativeID, counters); err != nil {
		return err
	}
	return tx.Commit()
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
