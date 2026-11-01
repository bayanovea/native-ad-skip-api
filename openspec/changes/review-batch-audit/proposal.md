# Proposal

Owner's request of 2026-11-01 (no backlog item): today every finished assessor batch waits for the owner to write "check these batches", after which Claude runs the same read-only queries by hand through the owner's `!` SSH. The check should run on its own, keep its results for later analysis, and reach the owner only where they need to step in.

## Why

The ten batch checks in the session history (ai-judge, ai-served, below-threshold, corpus, heldout, overlap) repeat the same steps: completeness, proposed × verdict, category flips, bounds and comments, the reviewer's pace, inter-reviewer agreement, the judge's reason against the verdicts, precision of a sample. Except for reading the comments, every step is SQL over the prod review tables, and every check costs the owner a message, a pasted command and a wait. Prod reads go only through the owner's terminal (since 2026-10-28), so the check stalls whenever the owner is away, while judge batches (`urgent`) now arrive daily.

## What Changes

- **`ai audit`**, a new subcommand of the prv `ai` binary on cron (hourly, `flock`), gated by `AI_AUDIT_ENABLED` (default `off`). One tick audits every review batch that is finished (as many finishers as `reviews_needed`, no holder), has at least one finisher other than the owner (`bayanovea`), has had no new verdict for 30 min, and has verdicts newer than its last audit.
- **Findings, two sources.** Fixed SQL rules produce the numeric findings (`category_flip`, `judge_false_alarm`, `rubber_stamp`, `precision`, `agreement`, `bounds`, `track_mismatch`, `eval_ready`), each with a fixed severity and its numbers as `evidence`. One Messages API call (`AI_AUDIT_MODEL`) reads the comments, the items and the rule findings, and adds only `comment` / `other` findings plus a one-sentence summary. An LLM finding must name item codes of the batch, or it is dropped. A finding is `{kind, severity: owner|backlog|info, items, text, evidence, action}`; `action` is a typed suggestion (`blind_subset`, `backlog_item`, `eval_import`, `reviewer_note`, `none`) that nothing acts on yet (owner, 2026-11-01: report only for now, actions later).
- **Record.** One row per audit in a new table `prv_review_audits`: batch, verdict watermark, metrics, findings, summary, model, prompt sha, raw output, usage, cost, LLM error, `notified_at`, `hidden_at` / `hidden_by`. Rows are never deleted. A re-audit after later verdicts is a new row, and the old one stays.
- **Owner's block on `/admin/review`.** With `reviewer=bayanovea`, the batch list shows "Findings": the latest audit of each batch that has `owner` / `backlog` findings and is not hidden, with its findings and a "Hide" button (`POST /admin/review/audits/:id/hide`). Other reviewers never see it. This keeps the block out of the assessors' way; it is not access control (owner, 2026-11-01).
- **Telegram ping, once per new finding.** After an audit commits, the tick sends one plain-text message to the alerting bot's chat (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, now also passed to the app). It lists the `owner` / `backlog` findings that the batch's previous audit did not have. No repeat, no message for `info` findings. A failed send is retried on later ticks until it succeeds.
- **Observability.** Heartbeat `ai_audit` (`CalculatorStale` limit 2 h, `CalculatorFailedVideos` counts failed batches), the cost kind `audit` on `/metrics` and so in `AiCostDaily`, and the heartbeat stat override on `infrastructure.json`.
- Docs: CLAUDE.md (Ops, AI-first segments → a short pointer, Routes → `admin-review.js`, Database Models, Prometheus Metrics, Alerting, Environment Variables).

## Capabilities

### New Capabilities
- `review-batch-audit`: which batches get audited and when, what an audit computes and records, how its findings reach the owner (page block, hide, Telegram), and how the switch gates it.

### Modified Capabilities
(none: the audit only reads verdicts, items and AI rows; `ai-verdict-application` and `admin-ai-review-request` are untouched.)

## Impact

- Go: `ai/audit/` (new: due batches, rules, LLM call, record, Telegram), `prv/commands/ai/main.go` (`audit` subcommand), `ai/prompts/audit-v1.md` (product-owned), `test/fixtures/ai/<batch>.audit.json` for `AI_CLIENT=fixture`.
- Node: `prv/db/index.js` (`ReviewAudit` model, table by `sync()`), `prv/repository/review.js` (owner audits, hide), `prv/routes/admin-review.js` (block, hide route), `prv/locales/review/{ru,en}.json`, `server.js` (`normalizePath`), `prometheus-wrapper.js` (cost kind).
- Infra: `crontab`, `docker-compose.yml` (`AI_AUDIT_ENABLED`, `AI_AUDIT_MODEL`, the two Telegram variables to `app`), `.github/workflows/deploy.yml` (both lists), `infrastructure/init/init_env.sh` (Telegram variables into `/app/.env`), `grafana/provisioning/alerting/rules.yml`, `grafana/dashboards/infrastructure.json`, `grafana/dashboards/ai-pipeline.json` (cost total).
- Tests: Go unit tests in `ai/audit` (sqlmock, fixtures), `test/e2e.js` (`audit:` tests: due batches, record, re-audit, the owner block and hide, ping retry against a stub Telegram endpoint), `make test-unit` where a pure helper is added.
- Cost: one Messages call per finished batch, a few cents; batches arrive a few a day.
- No change to serving, votes, verdicts, the judge or any review flow: the audit writes only its own table and the ping.

## Out of scope

- Acting on findings (creating a blind subset batch, writing a backlog file, messaging assessors) or a "Do it" button: later, once the `action` / hide history shows which suggestions the owner accepts.
- The eval side (verdict export, `adskip review`, score / rank on the owner's Mac): the audit only flags a finished sheet batch with `eval_ready` and the command to run.
- Linking a blind subset sheet to its original for agreement: no stored link exists; only reviewers of the same batch are compared.
- Interim checks of unfinished batches (e.g. pace mid-batch).
- Authentication of the owner's block beyond the reviewer code.
