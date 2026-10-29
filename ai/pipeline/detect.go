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
	"io/fs"
	"log"
	"math"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/ai/platform"
	"odedohbest/video-calculate/ai/provider"
	"odedohbest/video-calculate/ai/transcript"
	"odedohbest/video-calculate/ai/vtt"
	"odedohbest/video-calculate/ai/ytdlp"
	"odedohbest/video-calculate/calculator"
)

// Config is the detector's environment. Every switch defaults off.
type Config struct {
	DetectEnabled     bool          // AI_DETECT_ENABLED=on
	MinViews          int           // AI_MIN_VIEWS
	MinRequests       int           // AI_MIN_REQUESTS: GET count that queues a video on its own, views known or not
	DailyBudget       int           // AI_DAILY_BUDGET_VIDEOS: model calls per 24 h
	BatchMax          int           // AI_BATCH_MAX: videos per tick
	MinSegmentSeconds int           // AI_MIN_SEGMENT_SECONDS: shorter entries are hidden, not served (lib/ai-rules.js reads it too)
	FetchPause        time.Duration // AI_FETCH_PAUSE: mean pause before each video's fetch on a cron tick
	Model             string        // AI_MODEL
	Client            string        // AI_CLIENT: anthropic (Batches API) | messages (one call per video) | fixture
	FixtureDir        string        // AI_FIXTURE_DIR: <native_id>.detect.json for AI_CLIENT=fixture
	PromptPath        string        // AI_PROMPT
	YtdlpBin          string        // YTDLP_BIN
}

// ConfigFromEnv reads Config; an empty variable takes the default.
func ConfigFromEnv() (Config, error) {
	c := Config{
		DetectEnabled: os.Getenv("AI_DETECT_ENABLED") == "on",
		Model:         env("AI_MODEL", "claude-sonnet-5-5"),
		Client:        env("AI_CLIENT", "anthropic"),
		FixtureDir:    env("AI_FIXTURE_DIR", "/app/test/fixtures/ai"),
		PromptPath:    env("AI_PROMPT", "/app/ai/prompts/v2.2.md"),
		// Absolute: cron's PATH (/usr/bin:/bin) does not reach the image's /usr/local/bin.
		YtdlpBin: env("YTDLP_BIN", "/usr/local/bin/yt-dlp"),
	}
	for _, v := range []struct {
		name string
		def  int
		dst  *int
	}{
		{"AI_MIN_VIEWS", 500000, &c.MinViews},
		{"AI_MIN_REQUESTS", 20, &c.MinRequests},
		{"AI_DAILY_BUDGET_VIDEOS", 300, &c.DailyBudget},
		{"AI_BATCH_MAX", 5, &c.BatchMax},
		{"AI_MIN_SEGMENT_SECONDS", 5, &c.MinSegmentSeconds},
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
	if c.MinSegmentSeconds < 1 {
		return c, fmt.Errorf("AI_MIN_SEGMENT_SECONDS must be at least 1, got %d", c.MinSegmentSeconds)
	}
	c.FetchPause = 40 * time.Second
	if s := os.Getenv("AI_FETCH_PAUSE"); s != "" {
		d, err := time.ParseDuration(s)
		if err != nil || d < 0 {
			return c, fmt.Errorf("AI_FETCH_PAUSE must be a non-negative duration, got %q", s)
		}
		c.FetchPause = d
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

// batchClient is the batch transport: detector.AnthropicBatch in production, detector.FixtureClient in tests.
type batchClient interface {
	Submit(ctx context.Context, reqs []detector.Request) (string, error)
	// Poll checks once; true when the batch has ended and its results are loaded.
	Poll(ctx context.Context, batchID string) (bool, error)
}

var (
	_ batchClient = (*detector.AnthropicBatch)(nil)
	_ batchClient = (*detector.FixtureClient)(nil)
)

type detectRun struct {
	cfg         Config
	db          *sql.DB
	client      detector.Client
	batch       batchClient // nil for the synchronous client
	prompt      detector.Prompt
	price       detector.Price
	priceFactor float64
	categories  map[string]int
	ytdlp       *ytdlp.Runner
	prv         provider.Provider
	fetchPause  time.Duration // 0 for the manual run
	fetchErrs   []fetchErr    // this detect call's yt-dlp errors, recorded once the call knows whether all failed
}

type fetchErr struct {
	q   queued
	msg string
}

// blockedMin is how many fetches of one tick must all fail before the tick blames
// the host instead of the videos: one unavailable video is ordinary.
const blockedMin = 2

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
// manual run), it runs whatever AI_DETECT_ENABLED says, and it calls the model
// synchronously (a batch would wait for a cron tick that may be switched off), so
// it exits 1 unless the video ends published. A switched-off cron tick only
// expires stale runs and clears the ai_detect heartbeat.
func Detect(cfg Config, nativeID string) error {
	manual := nativeID != ""
	if !manual && !cfg.DetectEnabled {
		db := calculator.ConnectDb()
		defer db.Close()
		// Runs submitted before the switch went off: failed after 24 h, so a manual run can claim them again.
		if err := (&detectRun{db: db}).expire(); err != nil {
			log.Printf("ai detect: expire: %v", err)
		}
		return calculator.ClearHeartbeat(db, "ai_detect")
	}
	r, err := newDetectRun(cfg, manual)
	if err != nil {
		return err
	}
	r.db = calculator.ConnectDb()
	defer r.db.Close()
	if r.categories, err = loadCategories(r.db); err != nil {
		return err
	}

	ctx := context.Background()
	if manual {
		q, err := claimOne(r.db, nativeID)
		if err != nil {
			return err
		}
		if r.detect(ctx, []queued{q}) > 0 {
			return fmt.Errorf("%s failed", nativeID)
		}
		return manualOutcome(r.db, nativeID)
	}

	failed, err := r.tick(ctx)
	if herr := calculator.WriteHeartbeatStatus(r.db, "ai_detect", failed, err == nil); herr != nil {
		log.Printf("Heartbeat write failed: %v", herr)
		return errors.Join(fmt.Errorf("heartbeat: %w", herr), err)
	}
	if err != nil {
		return fmt.Errorf("tick incomplete (%d videos failed): %w", failed, err)
	}
	if failed > 0 {
		return fmt.Errorf("tick incomplete: %d videos failed", failed)
	}
	return nil
}

// newDetectRun loads the prompt and picks the model client: a manual run always
// calls the model synchronously, a cron tick uses the Batches API unless
// AI_CLIENT=messages.
func newDetectRun(cfg Config, manual bool) (*detectRun, error) {
	prompt, err := detector.LoadPrompt(cfg.PromptPath)
	if err != nil {
		return nil, err
	}
	r := &detectRun{cfg: cfg, prompt: prompt, priceFactor: 1,
		ytdlp: &ytdlp.Runner{Bin: cfg.YtdlpBin, Attempts: 2, Timeout: 90 * time.Second, Backoff: 2 * time.Second, Logf: log.Printf}}
	if !manual {
		r.fetchPause = cfg.FetchPause
	}
	if r.prv, err = platform.FromEnv(); err != nil {
		return nil, err
	}
	switch {
	case cfg.Client == "fixture":
		f := detector.NewFixtureClient(cfg.FixtureDir, cfg.Model)
		r.client = f
		if !manual {
			r.batch = f
		}
	case cfg.Client == "anthropic" && !manual:
		b, err := detector.NewAnthropicBatch(cfg.Model, effort)
		if err != nil {
			return nil, err
		}
		r.client, r.batch = b, b
	case cfg.Client == "anthropic" || cfg.Client == "messages":
		if r.client, err = detector.NewAnthropic(cfg.Model, effort); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("AI_CLIENT must be anthropic, messages or fixture, got %q", cfg.Client)
	}
	if r.batch != nil {
		r.priceFactor = 0.5 // the Batches API's discount; the fixture batch stands in for it
	}
	var priced bool
	if r.price, priced = detector.Prices[cfg.Model]; !priced {
		log.Printf("ai detect: no price for %s, cost recorded as 0", cfg.Model)
	}
	return r, nil
}

// tick is one cron run. `failed` counts videos the infrastructure failed (DB,
// API, a yt-dlp that cannot start), not what the tick decided about a video
// (unavailable, no track, an invalid answer, expired: recorded on its row);
// err is the failures of the tick's own steps.
func (r *detectRun) tick(ctx context.Context) (failed int, err error) {
	claimed, cerr := claimQueued(r.db, r.cfg)
	if cerr != nil {
		err = fmt.Errorf("claim: %w", cerr)
	}
	failed = r.detect(ctx, claimed)
	if r.batch != nil {
		n, perr := r.poll(ctx)
		failed += n
		if perr != nil {
			err = errors.Join(err, fmt.Errorf("list batches: %w", perr))
		}
	}
	if eerr := r.expire(); eerr != nil {
		err = errors.Join(err, fmt.Errorf("expire: %w", eerr))
	}
	return failed, err
}

// detect fetches the claimed videos and submits the ones that passed the gate.
func (r *detectRun) detect(ctx context.Context, claimed []queued) (failed int) {
	var ready []pending
	r.fetchErrs = nil
	for _, q := range claimed {
		time.Sleep(jitter(r.fetchPause))
		p, err := r.fetch(ctx, q)
		if err != nil {
			log.Printf("ai detect: %s %v", q.nativeID, err)
			failed++
		} else if p != nil {
			ready = append(ready, *p)
		}
	}
	if n := len(r.fetchErrs); n >= blockedMin && n == len(claimed) && !r.hostFetches(ctx) {
		// Every fetch failing, a known-good video's too, looks like the provider refusing the host,
		// not like n broken videos: the tick's failure (CalculatorFailedVideos), and no
		// attempt spent, as for a yt-dlp that cannot start; the rows stay `fetching`,
		// claimed again after an hour.
		for _, e := range r.fetchErrs {
			log.Printf("ai detect: %s fetch failed: %s", e.q.nativeID, e.msg)
		}
		log.Printf("ai detect: every fetch of the tick failed (%d videos): the provider may be refusing the host", n)
		failed += n
	} else {
		for _, e := range r.fetchErrs {
			if err := r.recordFetchError(e); err != nil {
				log.Printf("ai detect: %s %v", e.q.nativeID, err)
				failed++
			}
		}
	}
	return failed + r.submit(ctx, ready)
}

// hostFetches tells broken videos from a refused host: it fetches the info of the
// latest published video. A quiet tick may claim only videos that fail on their own,
// and calling that a ban kept them `fetching` and alerting every hour (2026-10-25).
// No published video yet, or a failing one, leaves the ban standing.
func (r *detectRun) hostFetches(ctx context.Context) bool {
	var nativeID string
	err := r.db.QueryRow(`SELECT native_id FROM prv_ai_videos WHERE status = $1 ORDER BY updated_at DESC LIMIT 1`, statusPublished).Scan(&nativeID)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			log.Printf("ai detect: control video: %v", err)
		}
		return false
	}
	time.Sleep(jitter(r.fetchPause))
	if _, _, err := r.ytdlp.Info(ctx, r.prv.VideoURL(nativeID)); err != nil {
		log.Printf("ai detect: control video %s failed too: %s", nativeID, strings.ReplaceAll(err.Error(), "\n", ": "))
		return false
	}
	log.Printf("ai detect: every fetch of the tick failed, control video %s did not: the videos' errors", nativeID)
	return true
}

// jitter spreads a pause over [d/2, 3d/2), so the provider never sees our host's fetches
// as a burst at the cron minute: a ban of the shared IP would stop every fetch.
func jitter(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}
	return d/2 + rand.N(d)
}

// manualOutcome is the manual run's exit: an error unless the video ended published.
func manualOutcome(db *sql.DB, nativeID string) error {
	var status string
	var lastErr sql.NullString
	if err := db.QueryRow(`SELECT status, last_error FROM prv_ai_videos WHERE native_id = $1`, nativeID).Scan(&status, &lastErr); err != nil {
		return err
	}
	if status != statusPublished {
		return fmt.Errorf("%s %s: %s", nativeID, status, lastErr.String)
	}
	return nil
}

// fetch downloads the video's subtitles and applies the gate. It returns nil
// without an error when the video left the tick for a known reason (no track,
// timeline), having recorded that on the row.
func (r *detectRun) fetch(ctx context.Context, q queued) (*pending, error) {
	url := r.prv.VideoURL(q.nativeID)
	info, _, err := r.ytdlp.Info(ctx, url)
	if err != nil {
		return nil, r.fetchError(q, err)
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
		if err := setStatus(r.db, q.nativeID, statusTimelineUnreliable, reason); err != nil {
			return nil, err
		}
		log.Printf("ai detect: %s timeline_unreliable: %s", q.nativeID, reason)
		return nil, nil
	}
	videoID, ok, err := findOrCreateVideo(r.db, q.nativeID, int(math.Round(info.Duration)))
	if err != nil {
		return nil, fmt.Errorf("videos row: %w", err)
	}
	if !ok {
		reason := fmt.Sprintf("yt-dlp's %.0f s is more than %d s off every duration players reported", info.Duration, calculator.DurationTolerance)
		if err := setStatus(r.db, q.nativeID, statusTimelineUnreliable, reason); err != nil {
			return nil, err
		}
		log.Printf("ai detect: %s timeline_unreliable: %s", q.nativeID, reason)
		return nil, nil
	}
	variants, err := durationVariants(r.db, q.nativeID, info.Duration)
	if err != nil {
		return nil, fmt.Errorf("duration variants: %w", err)
	}
	if variants > 0 {
		log.Printf("ai detect: duration variants: %s has %d videos rows off yt-dlp's %.0f s by more than %d s", q.nativeID, variants, info.Duration, calculator.DurationTolerance)
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

// fetchError keeps a failed yt-dlp call for detect to record as an attempt of the
// video; its message is flattened to one line (the runner joins the attempts'
// errors with newlines). A yt-dlp that cannot start is the host's fault, not the
// video's: it is returned unrecorded, and the row, left in `fetching`, is claimed
// again after an hour.
func (r *detectRun) fetchError(q queued, err error) error {
	var execErr *exec.Error
	if errors.As(err, &execErr) || errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrPermission) {
		return err
	}
	r.fetchErrs = append(r.fetchErrs, fetchErr{q, strings.ReplaceAll(err.Error(), "\n", ": ")})
	return nil
}

func (r *detectRun) recordFetchError(e fetchErr) error {
	status, err := markAttempt(r.db, e.q, false, e.msg)
	if err != nil {
		return err
	}
	log.Printf("ai detect: %s %s after fetch attempt %d: %s", e.q.nativeID, status, e.q.attempts+1, e.msg)
	return nil
}

func (r *detectRun) noTrack(q queued) error {
	status, err := markAttempt(r.db, q, true, "no "+lang+" subtitle track")
	if err != nil {
		return err
	}
	log.Printf("ai detect: %s %s: no %s subtitle track (attempt %d)", q.nativeID, status, lang, q.attempts+1)
	return nil
}

// submit records a prv_ai_runs row per video, then sends the videos as one batch
// (or calls the model per video with the synchronous client). The run rows come
// first, so the daily budget counts a submitted batch even if the tick dies
// before the batch id is stored: those rows stay `detecting` without one and
// expire, rather than being claimed and paid for again.
func (r *detectRun) submit(ctx context.Context, ready []pending) (failed int) {
	var started []pending
	var runIDs []int64
	for _, p := range ready {
		runID, err := r.startRun(p)
		if err != nil {
			log.Printf("ai detect: %s run row: %v", p.q.nativeID, err)
			failed++
			continue
		}
		if r.batch == nil {
			res, err := r.client.Detect(ctx, p.req)
			if err := r.finish(p.q.nativeID, runID, p.videoID, p.cues, res, err); err != nil {
				log.Printf("ai detect: %s %v", p.q.nativeID, err)
				failed++
			}
			continue
		}
		started = append(started, p)
		runIDs = append(runIDs, runID)
	}
	if len(started) == 0 {
		return failed
	}
	reqs := make([]detector.Request, len(started))
	ids := make([]string, len(started))
	for i, p := range started {
		reqs[i], ids[i] = p.req, p.q.nativeID
	}
	batchID, err := r.batch.Submit(ctx, reqs)
	if err != nil {
		// Nothing was sent, so a rejection (quota, billing, an API outage) is the account's, not
		// the videos': the run rows go and the videos are queued again in an hour, no attempt spent.
		for i, p := range started {
			msg := "batch submit: " + strings.ReplaceAll(err.Error(), "\n", ": ")
			_, derr := r.db.Exec(`DELETE FROM prv_ai_runs WHERE id = $1`, runIDs[i])
			qerr := requeue(r.db, p.q.nativeID, msg, time.Hour)
			if err := errors.Join(derr, qerr); err != nil {
				log.Printf("ai detect: %s: %v", p.q.nativeID, err)
			}
			log.Printf("ai detect: %s queued after %s (no attempt spent)", p.q.nativeID, msg)
		}
		return failed + len(started)
	}
	if _, err := r.db.Exec(`UPDATE prv_ai_videos SET batch_id = $2, updated_at = NOW() WHERE native_id = ANY($1)`,
		pq.Array(ids), batchID); err != nil {
		log.Printf("ai detect: batch %s: storing its id: %v", batchID, err)
		return failed + len(started)
	}
	log.Printf("ai detect: batch %s submitted: %d videos", batchID, len(started))
	return failed
}

func (r *detectRun) startRun(p pending) (int64, error) {
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
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'detecting', batch_id = NULL, last_error = NULL, updated_at = NOW()
		WHERE native_id = $1`, p.q.nativeID); err != nil {
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

// poll checks every batch with videos waiting on it once and resolves the ended
// ones; err is a failure to list them.
func (r *detectRun) poll(ctx context.Context) (failed int, err error) {
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
		return 0, err
	}
	batches := map[string][]waiting{}
	for rows.Next() {
		var w waiting
		var batchID string
		var tr []byte
		if err := rows.Scan(&w.nativeID, &batchID, &w.runID, &w.videoID, &tr); err != nil {
			rows.Close()
			return failed, err
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
		return failed, err
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
			if err := r.finish(w.nativeID, w.runID, w.videoID, w.cues, res, err); err != nil {
				log.Printf("ai detect: %s %v", w.nativeID, err)
				failed++
			}
		}
	}
	return failed, nil
}

// expire fails videos whose model call has not come back within 24 h (a batch
// that never ended or was never stored, or a synchronous run that crashed mid-call).
func (r *detectRun) expire() error {
	rows, err := r.db.Query(`UPDATE prv_ai_videos SET status = 'failed', last_error = 'no model result after 24 h', updated_at = NOW()
		WHERE status = 'detecting' AND updated_at < NOW() - INTERVAL '24 hours' RETURNING native_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		log.Printf("ai detect: %s failed: no model result after 24 h", id)
	}
	return rows.Err()
}

// finish records the model's answer on the run and publishes the video, in one
// transaction under the queue row's lock; a video another run already resolved is
// skipped. A failed call or an invalid answer marks the video failed (the run row
// keeps what came back); the error return is for the database only, and the caller logs it.
func (r *detectRun) finish(nativeID string, runID int64, videoID int, cues []vtt.Cue, res detector.Result, callErr error) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRow(`SELECT status FROM prv_ai_videos WHERE native_id = $1 FOR UPDATE`, nativeID).Scan(&status); err != nil {
		return fmt.Errorf("lock queue row: %w", err)
	}
	if status != statusDetecting {
		return nil
	}

	usage, err := json.Marshal(usageRow{res.Usage.InputTokens, res.Usage.OutputTokens, res.Usage.CacheReadTokens, res.Usage.CacheWriteTokens})
	if err != nil {
		return fmt.Errorf("run %d usage: %w", runID, err)
	}
	cost := r.price.Cost(res.Usage) * r.priceFactor
	if _, err := tx.Exec(`UPDATE prv_ai_runs SET raw_output = $2, usage = $3, cost_usd = $4 WHERE id = $1`,
		runID, rawJSON(res.Raw), usage, cost); err != nil {
		return fmt.Errorf("run %d: %w", runID, err)
	}

	units := requestFormat.Apply(cues)
	if callErr == nil {
		callErr = detector.Validate(units, res.Output)
	}
	if callErr != nil {
		if err := setStatus(tx, nativeID, statusFailed, callErr.Error()); err != nil {
			return fmt.Errorf("mark failed: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit failed: %w", err)
		}
		log.Printf("ai detect: %s failed: %v", nativeID, callErr)
		return nil
	}

	data, hidden := entries(detector.Resolve(units, res.Output), r.categories, r.cfg.MinSegmentSeconds)
	if err := publish(tx, videoID, nativeID, runID, data, hidden); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'published', batch_id = NULL, last_error = NULL, updated_at = NOW()
		WHERE native_id = $1`, nativeID); err != nil {
		return fmt.Errorf("mark published: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit published: %w", err)
	}
	log.Printf("ai detect: %s published: %d served, %d hidden of %d segments, video %d, run %d, $%.4f",
		nativeID, len(data), len(hidden), len(res.Output.Segments), videoID, runID, cost)
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
