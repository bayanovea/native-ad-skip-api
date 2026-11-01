# Tasks

## 1. Table and Node side

- [x] 1.1 `prv/db/index.js`: model `ReviewAudit` (table `prv_review_audits`, columns per design "Table", index on `batch`), exported with the others; created by `sync()`, nothing in `lib/schema.js`. Verify: `node scripts/sync-db.js` against the local dump (localhost:5433) creates the table; `\d prv_review_audits` matches the design.
- [x] 1.2 `prv/repository/review.js`: `OWNER_REVIEWER`, `ownerAudits()` (latest row per batch, not hidden, with a new `owner` / `backlog` finding) and `hideAudit(id, reviewer)` (403 / 404 / no-op on a second hide, as `ReviewInputError` codes). Verify: e2e 4.4.
- [x] 1.3 `prv/routes/admin-review.js`: the findings block above the sections of `renderBatchList` and `audits` in the list JSON, both only for `OWNER_REVIEWER`; `POST /admin/review/audits/:id/hide` (same auth as the other routes, body `{reviewer}`, form → 303 back to the list, JSON → 200); `prv/locales/review/{ru,en}.json` keys (block title, severity labels, hide button, empty summary); `server.js` `normalizePath` for `/admin/review/audits/#id/hide`. Verify: `make test-unit` (`test/i18n.test.js` parity), e2e 4.4.
- [x] 1.4 `prometheus-wrapper.js`: `costOf('audit', 'prv_review_audits')` in the cost UNION. Verify: `test/prometheus-wrapper.test.js` expects the fourth kind; e2e 4.2 reads `ai_cost_usd{kind="audit"}` on `/metrics`.

## 2. Go: `ai audit`

- [x] 2.1 `ai/audit/config.go`: `Config` + `ConfigFromEnv` (`AI_AUDIT_ENABLED`, `AI_AUDIT_MODEL` default `claude-sonnet-5-5`, `AI_AUDIT_PROMPT` default `/app/ai/prompts/audit-v1.md`, `AI_CLIENT`, `AI_FIXTURE_DIR`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_API_URL` default `https://api.telegram.org`); the key and Telegram checks run only when the tick would audit (switch on, or the manual run). Verify: `config_test.go` (defaults, switch off needs nothing, each missing variable named).
- [x] 2.2 `ai/audit/due.go`: the due-batches query (design "Due batches") and the per-batch `REPEATABLE READ READ ONLY` read into a `batchData` struct (items, all verdicts, latest video flags, judgement rows of judge items). Verify: `due_test.go` with sqlmock (the query's bounds: 30 min, 7 days, owner-only, watermark, `locked_by`), and e2e 4.1.
- [x] 2.3 `ai/audit/rules.go`: the eight rule findings with the design's constants, item source from `flagged_by`, Wilson lower bound, `new` against the previous row's findings. Verify: `rules_test.go`, one table case per scenario of the spec's "Rule findings" requirement plus "no condition → no finding" and `sponsor+self_promotion` → no flip.
- [x] 2.4 `ai/audit/llm.go` + `ai/prompts/audit-v1.md`: request building (cues cut to 600 chars), structured-output schema, answer check (unknown item codes dropped and counted, `text` cut to 400), Messages client and fixture client `<batch>.audit.json` (reuse the judge's client constructor if it moves to a shared spot without changing the judge's behaviour). Verify: `llm_test.go` (valid answer, dropped finding, schema failure → `llm_error`, transport error → batch failed).
- [x] 2.5 `ai/audit/notify.go`: `sendMessage` (plain text, ≤ 4000 chars, no token or host in the text), resend of unnotified rows, `notified_at`. Verify: `notify_test.go` with `httptest` (one message per new owner/backlog finding set, none for info only, failure → row stays unnotified and counts failed, a second tick sends it once).
- [x] 2.6 `ai/audit/audit.go` + `prv/commands/ai/main.go`: `Run(cfg, batch)`: tick (switch off → `ClearHeartbeat("ai_audit")`; resend, then due batches; heartbeat `ai_audit` with failed batches) and manual run `ai audit <batch>` (ignores switch, owner-only, settle, window and watermark; refuses an unfinished batch with exit 1; no heartbeat); the usage line. Verify: `audit_test.go` (switch off, one failed batch → heartbeat failed 1), `go vet ./...`.

## 3. Wiring and dashboards

- [x] 3.1 `crontab`: `45 * * * * flock -n /tmp/ai-audit.lock /app/prv/commands/ai/ai audit >> /proc/1/fd/1 2>&1` with the one-line comment of the other AI lines. Verify: the image's `crontab -l` in the e2e container shows it.
- [x] 3.2 `docker-compose.yml` (`AI_AUDIT_ENABLED=${AI_AUDIT_ENABLED:-off}`, `AI_AUDIT_MODEL=${AI_AUDIT_MODEL:-}`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` on `app`), `.github/workflows/deploy.yml` (both lists: two `vars.*`; the Telegram secrets are already in both), `infrastructure/init/init_env.sh` (`TELEGRAM_[A-Z_]+` in the grep). Verify: `docker compose -f docker-compose.yml config` shows the four on `app`; `grep -c AI_AUDIT .github/workflows/deploy.yml` = 4.
- [x] 3.3 `grafana/provisioning/alerting/rules.yml`: `CalculatorStale` selector `ai_audit` / 7200 and the summary's list of limits. `grafana/dashboards/infrastructure.json`: `ai_audit` override on the heartbeat stat (as `ai_judge`). `grafana/dashboards/ai-pipeline.json`: `prv_review_audits` in the two cost totals and an `audit` series in the cost-per-day panel. Verify: each changed SQL run against the local dump with a seeded `prv_review_audits` row; `python3 -m json.tool` on both JSON files; `yamllint`-free parse with `python3 -c 'import yaml…'`.

## 4. End-to-end tests (`test/e2e.js`, fixtures `test/fixtures/ai/`)

- [x] 4.1 `audit: a batch finished by an assessor 31 min ago is audited once; one still settling, one with an open item, one finished by bayanovea only and one older than 7 days are not`. Seed verdict times with `decided_at` in the past. Verify: `make test-e2e`.
- [x] 4.2 `audit: an ai batch's AI rows, items and verdicts are unchanged by the audit; the row carries metrics, rule findings, the fixture's comment finding (a finding with an unknown code dropped), cost; /metrics has kind audit`. Fixture `<batch>.audit.json`. Verify: `make test-e2e`.
- [x] 4.3 `audit: a changed verdict makes the batch due again; the new row marks unchanged findings not new; AI_AUDIT_ENABLED off writes nothing and clears the heartbeat; ai audit <batch> on an unfinished batch exits 1`. Verify: `make test-e2e`.
- [x] 4.4 `audit: the owner block lists the audit for bayanovea only (HTML and JSON), hide by another code is 403, hide by bayanovea removes it`. Verify: `make test-e2e`.
- [x] 4.5 `audit: a stub Telegram server (node:http in the test process, TELEGRAM_API_URL) gets one message with the new findings and no AUTH_TOKEN; a 500 leaves the row unnotified and the next run sends it`. The binary runs with async `spawn`, so the test's event loop can answer. Verify: `make test-e2e`.

## 5. Docs

- [x] 5.1 CLAUDE.md: Commands (`ai audit [batch]`), Ops (an "Audit" bullet: what is due, switch-on steps, the manual run), Routes → `admin-review.js` (owner block, hide route), Database Models (`ReviewAudit`), Prometheus Metrics (`audit` kind), Alerting (`CalculatorStale` limit), Environment Variables (`AI_AUDIT_*`, Telegram on the app, `TELEGRAM_API_URL`), Calculation Algorithm step 4's heartbeat list (`ai_audit`). Verify: every name in the text exists in the diff (`grep` each).
- [x] 5.2 Cleanup pass before commit: leftover names via `grep -rn "ai_audit\|AI_AUDIT\|prv_review_audits"` outside `vendor/` match the docs, no transient state in the artifacts, open questions moved to `docs/backlog/` (the actions follow-up: "Do it" per finding, from the hide / action history). Verify: `openspec validate review-batch-audit --strict` passes; `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `make test-e2e` green.

## Workflow follow-up

- Deploy with `AI_AUDIT_ENABLED` unset; check the table exists and the cron line exits at once.
- Owner runs `ai audit <batch>` inside the app container on one recent finished batch, checks the block on `/admin/review` and the Telegram message.
- Owner sets the repository variable `AI_AUDIT_ENABLED=on` (Variables tab) and redeploys with `image_tag` = the running sha.
- Day-after check: `ai_audit` heartbeat on the infrastructure dashboard, audit rows of the day's finished batches, `ai_cost_usd_24h{kind="audit"}`.
- Archive after the prod check; the archive is the record.
