package judge

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	"odedohbest/video-calculate/calculator"
)

// Config is the judge's environment. Every switch defaults off.
type Config struct {
	Enabled bool // AI_JUDGE_ENABLED=on
}

func ConfigFromEnv() Config {
	return Config{Enabled: os.Getenv("AI_JUDGE_ENABLED") == "on"}
}

// Run is one cron tick: every due published row through signals and rules, one
// prv_ai_judgements row each, then the ai_judge heartbeat.
func Run(cfg Config) error {
	if !cfg.Enabled {
		return nil
	}
	db := calculator.ConnectDb()
	defer db.Close()
	categories, err := loadCategories(db)
	if err != nil {
		return err
	}
	failed, err := tick(db, categories, time.Now())
	if err != nil {
		log.Printf("ai judge: %v", err)
		failed++
	}
	if err := calculator.WriteHeartbeat(db, "ai_judge", failed); err != nil {
		log.Printf("Heartbeat write failed: %v", err)
		return fmt.Errorf("heartbeat: %w", err)
	}
	if failed > 0 {
		return fmt.Errorf("%d videos failed", failed)
	}
	return nil
}

func tick(db *sql.DB, categories map[int]string, now time.Time) (failed int, err error) {
	videos, err := dueVideos(db)
	if err != nil {
		return 0, err
	}
	for _, v := range videos {
		if err := judgeVideo(db, v, categories, now); err != nil {
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

func judgeVideo(db *sql.DB, v Video, categories map[int]string, now time.Time) error {
	var err error
	if v.Entries, err = parseEntries(v.Data); err != nil {
		return fmt.Errorf("data: %w", err)
	}
	s, err := collectSignals(db, v, categories, now)
	if err != nil {
		return err
	}
	if v.JudgedAt.Valid && !moved(v.JudgeCounters, s.Counters) {
		return nil
	}
	decision, reason := rules(s)
	if decision == needsLLM {
		// No LLM judge yet (Task 6): a human gets every case the rules do not close.
		decision, reason = decisionReview, needsLLM+": "+reason
	}
	if err := record(db, v, s, decision, reason); err != nil {
		return err
	}
	log.Printf("ai judge: %d %s rules: %s", v.VideoID, decision, reason)
	return nil
}

// record writes the judgement under the AI row's lock (the vote handler's order:
// AI row first), withdraws on a duration withdraw, and stores the counters the
// next tick compares against. A row withdrawn meanwhile is left alone.
func record(db *sql.DB, v Video, s Signals, decision, reason string) error {
	signals, err := json.Marshal(s)
	if err != nil {
		return err
	}
	counters, err := json.Marshal(s.Counters)
	if err != nil {
		return err
	}
	tx, err := db.Begin()
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
	if _, err := tx.Exec(`INSERT INTO prv_ai_judgements (video_id, decision, "by", reason, signals) VALUES ($1, $2, 'rules', $3, $4)`,
		v.VideoID, decision, reason, signals); err != nil {
		return err
	}
	if decision == decisionWithdraw {
		// The only rule withdraw is a re-cut, a fact rather than an opinion, so AI_JUDGE_AUTO_WITHDRAW does not gate it.
		if _, err := tx.Exec(`UPDATE prv_ai_video_calculateds SET withdrawn_at = NOW(), withdrawn_by = 'duration', withdrawn_reason = $2, updated_at = NOW()
			WHERE video_id = $1`, v.VideoID, reason); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE prv_ai_videos SET status = 'withdrawn' WHERE native_id = $1`, v.NativeID); err != nil {
			return err
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
