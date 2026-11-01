package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"

	"odedohbest/video-calculate/ai/detector"
	"odedohbest/video-calculate/calculator"
)

const heartbeat = "ai_audit"

type auditRun struct {
	db     *sql.DB
	llm    llmClient
	prompt detector.Prompt
	price  detector.Price
	tg     *telegram
}

// Run is one cron tick (batch "") or the manual run of one batch. The tick resends unsent
// pings, audits every due batch and writes the ai_audit heartbeat; switched off, it only clears
// that heartbeat. The manual run ignores the switch and the due rules and writes no heartbeat.
func Run(cfg Config, batch string) error {
	if batch == "" && !cfg.Enabled {
		db := calculator.ConnectDb()
		defer db.Close()
		return calculator.ClearHeartbeat(db, heartbeat)
	}
	if err := cfg.check(); err != nil {
		return err
	}
	r := &auditRun{tg: newTelegram(cfg)}
	var err error
	if r.llm, err = newLLMClient(cfg); err != nil {
		return err
	}
	if r.prompt, err = detector.LoadPrompt(cfg.PromptPath); err != nil {
		return err
	}
	var priced bool
	if r.price, priced = detector.Prices[cfg.Model]; !priced {
		log.Printf("ai audit: no price for %s, cost recorded as 0", cfg.Model)
	}
	r.db = calculator.ConnectDb()
	defer r.db.Close()
	if batch != "" {
		return r.audit(batch)
	}
	// A failed batch or send is retried next tick and fires CalculatorFailedVideos; the success,
	// which CalculatorStale watches, needs only the tick's own queries.
	failed, err := r.tick()
	if herr := calculator.WriteHeartbeatStatus(r.db, heartbeat, failed, err == nil); herr != nil {
		log.Printf("Heartbeat write failed: %v", herr)
		return errors.Join(fmt.Errorf("heartbeat: %w", herr), err)
	}
	if err != nil {
		return fmt.Errorf("tick incomplete (%d batches failed): %w", failed, err)
	}
	if failed > 0 {
		return fmt.Errorf("tick incomplete: %d batches failed", failed)
	}
	return nil
}

func (r *auditRun) tick() (failed int, err error) {
	unsent, err := r.unsent()
	if err != nil {
		return 0, err
	}
	for _, u := range unsent {
		if err := r.notify(u.id, u.batch, u.summary, u.findings); err != nil {
			log.Printf("ai audit: %s: resend of audit %d failed: %v", u.batch, u.id, err)
			failed++
		}
	}
	batches, err := dueBatches(r.db)
	if err != nil {
		return failed, err
	}
	for _, b := range batches {
		if err := r.audit(b); err != nil {
			log.Printf("ai audit: %s failed: %v", b, err)
			failed++
		}
	}
	return failed, nil
}

// audit reads the batch, applies the rules, asks the model, records the row and sends the
// new owner / backlog findings. A transport error writes nothing (the batch stays due); a failed
// send leaves the row unnotified for the next tick.
func (r *auditRun) audit(batch string) error {
	d, err := readBatch(r.db, batch)
	if err != nil {
		return err
	}
	m := metrics(d)
	findings := ruleFindings(d)
	req, err := renderRequest(r.prompt, d, m, findings)
	if err != nil {
		return err
	}
	res, err := r.llm.Audit(context.Background(), req)
	if err != nil {
		return fmt.Errorf("model call: %w", err)
	}
	summary, llmFindings, dropped, perr := parseOutput(res.Raw, d)
	m["model_findings_dropped"] = dropped
	findings = append(findings, llmFindings...)
	previous, err := r.previous(batch)
	if err != nil {
		return err
	}
	markNew(findings, previous)
	row := auditRow{batch: batch, watermark: d.Watermark, items: len(d.Items), metrics: m, findings: findings,
		summary: summary, model: r.llm.Model(), promptSHA: r.prompt.SHA, raw: res.Raw, usage: res.Usage,
		cost: r.price.Cost(res.Usage)}
	if perr != nil {
		row.llmError = perr.Error()
	}
	id, err := r.insert(row)
	if err != nil {
		return err
	}
	pings := 0
	for _, f := range findings {
		if f.pings() {
			pings++
		}
	}
	invalid := ""
	if perr != nil {
		invalid = ", model answer invalid: " + row.llmError
	}
	log.Printf("ai audit: %s audited (audit %d): %d findings, %d new for the owner, $%.4f%s",
		batch, id, len(findings), pings, row.cost, invalid)
	if pings == 0 {
		return nil
	}
	if err := r.notify(id, batch, summary, findings); err != nil {
		return fmt.Errorf("audit %d recorded, message not sent: %w", id, err)
	}
	return nil
}

func (r *auditRun) notify(id int, batch, summary string, findings []Finding) error {
	if err := r.tg.send(message(batch, summary, findings)); err != nil {
		return err
	}
	_, err := r.db.Exec(`UPDATE prv_review_audits SET notified_at = NOW() WHERE id = $1`, id)
	return err
}

type auditRow struct {
	batch            string
	watermark, items int
	metrics          map[string]any
	findings         []Finding
	summary, model   string
	promptSHA, raw   string
	usage            detector.Usage
	cost             float64
	llmError         string
}

func (r *auditRun) insert(a auditRow) (int, error) {
	m, err := json.Marshal(a.metrics)
	if err != nil {
		return 0, err
	}
	f, err := json.Marshal(a.findings)
	if err != nil {
		return 0, err
	}
	u, err := json.Marshal(a.usage)
	if err != nil {
		return 0, err
	}
	var id int
	err = r.db.QueryRow(`INSERT INTO prv_review_audits
			(batch, watermark, items, metrics, findings, summary, model, prompt_sha, raw_output, usage, cost_usd, llm_error)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), $7, $8, $9, $10, $11, NULLIF($12, ''))
		RETURNING id`,
		a.batch, a.watermark, a.items, m, f, a.summary, a.model, a.promptSHA, a.raw, u, a.cost, a.llmError).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("insert audit: %w", err)
	}
	return id, nil
}

// previous is the findings of the batch's latest audit, none when it has none.
func (r *auditRun) previous(batch string) ([]Finding, error) {
	var raw []byte
	err := r.db.QueryRow(`SELECT findings FROM prv_review_audits WHERE batch = $1 ORDER BY id DESC LIMIT 1`, batch).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("previous audit: %w", err)
	}
	var out []Finding
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("previous audit: %w", err)
	}
	return out, nil
}

type unsentAudit struct {
	id             int
	batch, summary string
	findings       []Finding
}

// unsent is every audit with a new owner / backlog finding whose message has not gone out.
func (r *auditRun) unsent() ([]unsentAudit, error) {
	rows, err := r.db.Query(`SELECT id, batch, COALESCE(summary, ''), findings FROM prv_review_audits a
		 WHERE notified_at IS NULL
		   AND EXISTS (SELECT 1 FROM jsonb_array_elements(a.findings) f
		                WHERE (f->>'new')::boolean AND f->>'severity' IN ('owner', 'backlog'))
		 ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("unsent audits: %w", err)
	}
	defer rows.Close()
	var out []unsentAudit
	for rows.Next() {
		var u unsentAudit
		var raw []byte
		if err := rows.Scan(&u.id, &u.batch, &u.summary, &raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &u.findings); err != nil {
			return nil, fmt.Errorf("audit %d findings: %w", u.id, err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
