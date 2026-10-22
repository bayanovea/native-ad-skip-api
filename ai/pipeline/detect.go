// Package pipeline is the product side of the detector (ai/detector, copied from
// the eval repo): the prv_ai_videos queue, subtitle fetch, timeline gate, model
// call and publish into prv_ai_video_calculateds.
package pipeline

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/vtt"
	"odedohbest/video-calculate/ai/ytdlp"
	"odedohbest/video-calculate/calculator"
)

// Config is the detector's environment. Every switch defaults off.
type Config struct {
	DetectEnabled    bool   // AI_DETECT_ENABLED=on
	MinViews         int    // AI_MIN_VIEWS
	FallbackRequests int    // AI_FALLBACK_REQUESTS: GET count that queues a video whose views are unknown
	DailyBudget      int    // AI_DAILY_BUDGET_VIDEOS: model calls per 24 h
	BatchMax         int    // AI_BATCH_MAX: videos per tick
	Model            string // AI_MODEL
	Client           string // AI_CLIENT: anthropic (Batches API) | messages (one call per video) | fixture
	FixtureDir       string // AI_FIXTURE_DIR: <native_id>.detect.json for AI_CLIENT=fixture
	PromptPath       string // AI_PROMPT
	YtdlpBin         string // YTDLP_BIN
}

// ConfigFromEnv reads Config; an empty variable takes the default.
func ConfigFromEnv() (Config, error) {
	c := Config{
		DetectEnabled: os.Getenv("AI_DETECT_ENABLED") == "on",
		Model:         env("AI_MODEL", "claude-sonnet-5-5"),
		Client:        env("AI_CLIENT", "anthropic"),
		FixtureDir:    env("AI_FIXTURE_DIR", "/app/test/fixtures/ai"),
		PromptPath:    env("AI_PROMPT", "/app/ai/prompts/v2.2.md"),
		YtdlpBin:      env("YTDLP_BIN", "yt-dlp"),
	}
	for _, v := range []struct {
		name string
		def  int
		dst  *int
	}{
		{"AI_MIN_VIEWS", 10000, &c.MinViews},
		{"AI_FALLBACK_REQUESTS", 3, &c.FallbackRequests},
		{"AI_DAILY_BUDGET_VIDEOS", 200, &c.DailyBudget},
		{"AI_BATCH_MAX", 100, &c.BatchMax},
	} {
		*v.dst = v.def
		if s := os.Getenv(v.name); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil || n < 0 {
				return c, fmt.Errorf("%s must be a non-negative integer, got %q", v.name, s)
			}
			*v.dst = n
		}
	}
	return c, nil
}

func env(name, def string) string {
	if s := os.Getenv(name); s != "" {
		return s
	}
	return def
}

const (
	lang = "ru"
	// effort and requestFormat are the held-out run's (eval runs/2026-10-18-…-v2.1-batch-nt).
	effort = "medium"
)

var requestFormat = detector.Format{NoTimes: true}

type detectRun struct {
	cfg         Config
	db          *sql.DB
	client      detector.Client
	batch       detector.BatchClient // nil for the synchronous client
	prompt      detector.Prompt
	price       detector.Price
	priceFactor float64
	categories  map[string]int
	ytdlp       *ytdlp.Runner
	prv          provider.Provider
}

// pending is a fetched video that passed the gate, waiting for its model call.
type pending struct {
	q       queued
	videoID int
	meta    transcript.Meta
	cues    []vtt.Cue
	overrun float64
	req     detector.Request
}

// Detect runs one cron tick: claim → fetch → gate → submit, then resolve the
// batches that have ended. With a nativeID it is the manual run for that video
// only: no views or budget check, no heartbeat (the cron's alert must not see a
// manual run), and it runs whatever AI_DETECT_ENABLED says. A switched-off cron
// tick only clears the ai_detect heartbeat.
func Detect(cfg Config, nativeID string) error {
	if nativeID == "" && !cfg.DetectEnabled {
		db := calculator.ConnectDb()
		defer db.Close()
		return calculator.ClearHeartbeat(db, "ai_detect")
	}
	prompt, err := detector.LoadPrompt(cfg.PromptPath)
	if err != nil {
		return err
	}
	r := &detectRun{cfg: cfg, prompt: prompt, priceFactor: 1,
		ytdlp: &ytdlp.Runner{Bin: cfg.YtdlpBin, Attempts: 2, Timeout: 90 * time.Second, Backoff: 2 * time.Second, Logf: log.Printf}}
	if r.prv, err = provider.Lookup("prv"); err != nil {
		return err
	}
	switch cfg.Client {
	case "anthropic":
		b, err := detector.NewAnthropicBatch(cfg.Model, effort)
		if err != nil {
			return err
		}
		r.client, r.batch, r.priceFactor = b, b, 0.5
	case "messages":
		if r.client, err = detector.NewAnthropic(cfg.Model, effort); err != nil {
			return err
		}
	case "fixture":
		f := detector.NewFixtureClient(cfg.FixtureDir, cfg.Model)
		r.client, r.batch = f, f
	default:
		return fmt.Errorf("AI_CLIENT must be anthropic, messages or fixture, got %q", cfg.Client)
	}
	var priced bool
	if r.price, priced = detector.Prices[cfg.Model]; !priced {
		log.Printf("ai detect: no price for %s, cost recorded as 0", cfg.Model)
	}

	r.db = calculator.ConnectDb()
	defer r.db.Close()
	if r.categories, err = loadCategories(r.db); err != nil {
		return err
	}

	failed := r.tick(context.Background(), nativeID)
	if nativeID == "" {
		if err := calculator.WriteHeartbeat(r.db, "ai_detect", failed); err != nil {
			log.Printf("Heartbeat write failed: %v", err)
			return fmt.Errorf("heartbeat: %w", err)
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d videos failed", failed)
	}
	return nil
}

func (r *detectRun) tick(ctx context.Context, nativeID string) (failed int) {
	var claimed []queued
	if nativeID != "" {
		q, err := claimOne(r.db, nativeID)
		if err != nil {
			log.Printf("ai detect: %s: %v", nativeID, err)
			return 1
		}
		claimed = []queued{q}
	} else {
		var err error
		if claimed, err = claimQueued(r.db, r.cfg); err != nil {
			log.Printf("ai detect: claim: %v", err)
			failed++
		}
	}

	var ready []pending
	for _, q := range claimed {
		p, err := r.fetch(ctx, q, nativeID == "")
		if err != nil {
			log.Printf("ai detect: %s %v", q.nativeID, err)
			failed++
		} else if p != nil {
			ready = append(ready, *p)
		}
	}
	failed += r.submit(ctx, ready)
	if r.batch != nil {
		failed += r.poll(ctx)
	}
	return failed + r.expire()
}

// fetch downloads the video's subtitles and applies the gate. It returns nil
// without an error when the video left the tick for a known reason (views, no
// track, timeline), having recorded that on the row.
func (r *detectRun) fetch(ctx context.Context, q queued, checkViews bool) (*pending, error) {
	url := r.prv.VideoURL(q.nativeID)
	info, raw, err := r.ytdlp.Info(ctx, url)
	if err != nil {
		return nil, r.fetchError(q, err)
	}
	if checkViews && !q.viewsMax.Valid {
		views := viewCount(raw)
		status := "fetching"
		if views < int64(r.cfg.MinViews) {
			status = "seen"
		}
		// views_max set, so the queue rule re-examines the row only once the extension reports more views.
		if _, err := r.db.Exec(`UPDATE prv_ai_videos SET views_max = GREATEST(views_max, $2), status = $3, updated_at = NOW()
			WHERE native_id = $1`, q.nativeID, views, status); err != nil {
			return nil, err
		}
		if status == "seen" {
			log.Printf("ai detect: %s seen: %d views below AI_MIN_VIEWS", q.nativeID, views)
			return nil, nil
		}
	}

	track, trackType, auto, ok := r.prv.PickTrack(info, lang)
	if !ok {
		return nil, r.noTrack(q)
	}
	dir, err := os.MkdirTemp("", "ai-detect-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	base := filepath.Join(dir, "subs")
	if err := r.ytdlp.WriteSubs(ctx, url, base, lang, auto); err != nil {
		return nil, r.fetchError(q, err)
	}
	cues, err := readVTT(base)
	if err != nil {
		return nil, r.fetchError(q, err)
	}
	if len(cues) == 0 {
		return nil, r.noTrack(q)
	}

	over := overrun(cues, info.Duration)
	if !timelineOK(over) {
		reason := fmt.Sprintf("last cue ends %.1f s after the video (%.0f s)", over, info.Duration)
		if err := setStatus(r.db, q.nativeID, "timeline_unreliable", reason); err != nil {
			return nil, err
		}
		log.Printf("ai detect: %s timeline_unreliable: %s", q.nativeID, reason)
		return nil, nil
	}
	videoID, err := findOrCreateVideo(r.db, q.nativeID, roundDuration(info.Duration))
	if err != nil {
		return nil, fmt.Errorf("videos row: %w", err)
	}
	variants, err := durationVariants(r.db, q.nativeID, info.Duration)
	if err != nil {
		return nil, fmt.Errorf("duration variants: %w", err)
	}
	if variants > 0 {
		log.Printf("ai: duration variants: %s has %d videos rows off yt-dlp's %.0f s by more than %d s", q.nativeID, variants, info.Duration, durationTolerance)
	}
	if _, err := r.db.Exec(`UPDATE prv_ai_videos SET judge_counters = COALESCE(judge_counters, '{}'::jsonb) || jsonb_build_object('duration_variants', $2::int)
		WHERE native_id = $1`, q.nativeID, variants); err != nil {
		return nil, err
	}

	meta := transcript.Meta{
		Kind: "meta", NativeID: q.nativeID, Provider: r.prv.Name(), Title: info.Title, Duration: info.Duration,
		Lang: lang, TrackType: trackType, TrackName: strings.TrimSpace(track.Name + " " + track.Ext),
		Cues: len(cues), Words: vtt.Words(cues), FetchedAt: time.Now().UTC(),
	}
	req := detector.NewRequestFormat(r.prompt, meta, requestFormat.Apply(cues), requestFormat)
	req.Key = q.nativeID
	return &pending{q: q, videoID: videoID, meta: meta, cues: cues, overrun: over, req: req}, nil
}

// readVTT reads what WriteSubs wrote: the first "<base>.<lang>*.vtt" (yt-dlp may add a track suffix).
func readVTT(base string) ([]vtt.Cue, error) {
	matches, _ := filepath.Glob(base + "." + lang + "*.vtt")
	if len(matches) == 0 {
		return nil, errors.New("yt-dlp reported a track but wrote no .vtt")
	}
	f, err := os.Open(matches[0])
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := vtt.Parse(f)
	if err != nil {
		return nil, err
	}
	return vtt.Collapse(raw), nil
}

// fetchError records a failed yt-dlp call; its message is flattened to one line
// (the runner joins the attempts' errors with newlines).
func (r *detectRun) fetchError(q queued, err error) error {
	msg := strings.ReplaceAll(err.Error(), "\n", ": ")
	status, uerr := markAttempt(r.db, q, false, msg)
	if uerr != nil {
		return errors.Join(err, uerr)
	}
	return fmt.Errorf("%s after fetch attempt %d: %s", status, q.attempts+1, msg)
}

func (r *detectRun) noTrack(q queued) error {
	status, err := markAttempt(r.db, q, true, "no "+lang+" subtitle track")
	if err != nil {
		return err
	}
	log.Printf("ai detect: %s %s: no %s subtitle track (attempt %d)", q.nativeID, status, lang, q.attempts+1)
	return nil
}

// submit sends the tick's videos as one batch (or calls the model per video with
// the synchronous client) and records a prv_ai_runs row per video.
func (r *detectRun) submit(ctx context.Context, ready []pending) (failed int) {
	if len(ready) == 0 {
		return 0
	}
	batchID := ""
	if r.batch != nil {
		reqs := make([]detector.Request, len(ready))
		for i, p := range ready {
			reqs[i] = p.req
		}
		id, err := r.batch.Submit(ctx, reqs)
		if err != nil {
			for _, p := range ready {
				log.Printf("ai detect: %s queued: batch submit: %v", p.q.nativeID, err)
				if _, err := r.db.Exec(`UPDATE prv_ai_videos SET status = 'queued', next_attempt_at = NOW(), last_error = $2, updated_at = NOW()
					WHERE native_id = $1`, p.q.nativeID, err.Error()); err != nil {
					log.Printf("ai detect: %s: %v", p.q.nativeID, err)
				}
			}
			return len(ready)
		}
		batchID = id
		log.Printf("ai detect: batch %s submitted: %d videos", batchID, len(ready))
	}
	for _, p := range ready {
		runID, err := r.startRun(p, batchID)
		if err != nil {
			log.Printf("ai detect: %s run row: %v", p.q.nativeID, err)
			failed++
			continue
		}
		if r.batch == nil {
			res, err := r.client.Detect(ctx, p.req)
			if r.finish(p.q.nativeID, runID, p.videoID, p.cues, res, err) != nil {
				failed++
			}
		}
	}
	return failed
}

func (r *detectRun) startRun(p pending, batchID string) (int64, error) {
	tr, err := json.Marshal(storedTranscript{Meta: p.meta, Cues: p.cues})
	if err != nil {
		return 0, err
	}
	tx, err := r.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var runID int64
	if err := tx.QueryRow(`INSERT INTO prv_ai_runs (native_id, video_id, prompt_sha, prompt_version, model, transcript, track_overrun_s, yt_duration_s)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		p.q.nativeID, p.videoID, r.prompt.SHA, r.prompt.Version, r.client.Model(), tr, p.overrun, p.meta.Duration).Scan(&runID); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'detecting', batch_id = $2, last_error = NULL, updated_at = NOW()
		WHERE native_id = $1`, p.q.nativeID, nullString(batchID)); err != nil {
		return 0, err
	}
	return runID, tx.Commit()
}

// storedTranscript is prv_ai_runs.transcript: the collapsed cues the request was
// rendered from, which Validate and Resolve need again when the batch ends.
type storedTranscript struct {
	Meta transcript.Meta `json:"meta"`
	Cues []vtt.Cue       `json:"cues"`
}

// poll checks every batch with videos waiting on it once and resolves the ended ones.
func (r *detectRun) poll(ctx context.Context) (failed int) {
	type waiting struct {
		nativeID string
		runID    int64
		videoID  int
		cues     []vtt.Cue
	}
	rows, err := r.db.Query(`SELECT v.native_id, v.batch_id, run.id, run.video_id, run.transcript
		FROM prv_ai_videos v
		JOIN LATERAL (SELECT id, video_id, transcript FROM prv_ai_runs WHERE native_id = v.native_id ORDER BY id DESC LIMIT 1) run ON TRUE
		WHERE v.status = 'detecting' AND v.batch_id IS NOT NULL`)
	if err != nil {
		log.Printf("ai detect: list batches: %v", err)
		return 1
	}
	batches := map[string][]waiting{}
	for rows.Next() {
		var w waiting
		var batchID string
		var tr []byte
		if err := rows.Scan(&w.nativeID, &batchID, &w.runID, &w.videoID, &tr); err != nil {
			rows.Close()
			log.Printf("ai detect: list batches: %v", err)
			return 1
		}
		var st storedTranscript
		if err := json.Unmarshal(tr, &st); err != nil {
			log.Printf("ai detect: %s run %d transcript: %v", w.nativeID, w.runID, err)
			failed++
			continue
		}
		w.cues = st.Cues
		batches[batchID] = append(batches[batchID], w)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		log.Printf("ai detect: list batches: %v", err)
		return failed + 1
	}

	for batchID, videos := range batches {
		ended, err := r.batch.Poll(ctx, batchID)
		if err != nil {
			log.Printf("ai detect: batch %s poll: %v", batchID, err)
			failed += len(videos)
			continue
		}
		if !ended {
			continue
		}
		for _, w := range videos {
			res, err := r.client.Detect(ctx, detector.Request{Key: w.nativeID})
			if r.finish(w.nativeID, w.runID, w.videoID, w.cues, res, err) != nil {
				failed++
			}
		}
	}
	return failed
}

// expire fails videos whose model call has not come back within 24 h
// (a batch that never ended, or a synchronous run that crashed mid-call).
func (r *detectRun) expire() (failed int) {
	rows, err := r.db.Query(`UPDATE prv_ai_videos SET status = 'failed', last_error = 'no model result after 24 h', updated_at = NOW()
		WHERE status = 'detecting' AND updated_at < NOW() - INTERVAL '24 hours' RETURNING native_id`)
	if err != nil {
		log.Printf("ai detect: expire: %v", err)
		return 1
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			log.Printf("ai detect: %s failed: no model result after 24 h", id)
			failed++
		}
	}
	return failed
}

// finish records the model's answer on the run and publishes the video, in one
// transaction under the queue row's lock; a video another run already resolved is skipped.
func (r *detectRun) finish(nativeID string, runID int64, videoID int, cues []vtt.Cue, res detector.Result, callErr error) error {
	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("ai detect: %s: %v", nativeID, err)
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRow(`SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE`, nativeID).Scan(&status); err != nil {
		log.Printf("ai detect: %s: %v", nativeID, err)
		return err
	}
	if status != "detecting" {
		return nil
	}

	usage, err := json.Marshal(usageRow{res.Usage.InputTokens, res.Usage.OutputTokens, res.Usage.CacheReadTokens, res.Usage.CacheWriteTokens})
	if err != nil {
		return err
	}
	cost := r.price.Cost(res.Usage) * r.priceFactor
	if _, err := tx.Exec(`UPDATE prv_ai_runs SET raw_output = $2, usage = $3, cost_usd = $4 WHERE id = $1`,
		runID, rawJSON(res.Raw), usage, cost); err != nil {
		log.Printf("ai detect: %s run %d: %v", nativeID, runID, err)
		return err
	}

	units := requestFormat.Apply(cues)
	if callErr == nil {
		callErr = detector.Validate(units, res.Output)
	}
	if callErr != nil {
		if err := setStatus(tx, nativeID, "failed", callErr.Error()); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		log.Printf("ai detect: %s failed: %v", nativeID, callErr)
		return callErr
	}

	data := entries(detector.Resolve(units, res.Output), r.categories)
	if err := publish(tx, videoID, nativeID, runID, data); err != nil {
		log.Printf("ai detect: %s %v", nativeID, err)
		return err
	}
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'published', batch_id = NULL, last_error = NULL, updated_at = NOW()
		WHERE native_id = $1`, nativeID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		log.Printf("ai detect: %s: %v", nativeID, err)
		return err
	}
	log.Printf("ai detect: %s published: %d entries of %d segments, video %d, run %d, $%.4f",
		nativeID, len(data), len(res.Output.Segments), videoID, runID, cost)
	return nil
}

type usageRow struct {
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
	CacheReadTokens  int `json:"cache_read_tokens"`
	CacheWriteTokens int `json:"cache_write_tokens"`
}

// rawJSON is the model's text for a JSONB column: as is when it is JSON (the
// schema makes it so), else as a JSON string, NULL when there was no answer.
func rawJSON(raw string) any {
	if raw == "" {
		return nil
	}
	if json.Valid([]byte(raw)) {
		return raw
	}
	b, _ := json.Marshal(raw)
	return string(b)
}
