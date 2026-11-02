# Design

## Context

See proposal.md, Why. What already exists and shapes the approach:

- The prv `ai` binary (`prv/commands/ai/main.go`) runs `detect` and `judge` from the container's cron under `flock`, reads `/app/.env`, writes a `calculator_heartbeats` row, and has an Anthropic Messages client with a fixture transport (`ai/judge/llm.go`, `AI_CLIENT=fixture`) and per-model prices (`detector.Prices`).
- The review state is SQL: finishers per batch (`finishedOf` in `prv/repository/review.js`), the latest verdict per item and reviewer (`decided_at DESC, id DESC`), bounds on verdicts, `flagged_by` lines that encode where an ai item came from (`judge <decision> by <by>: <reason>`, `detect run <id>: … served`, `… hidden: <reason>`, `second <model>: not found`, `admin: sent to review`), video flags in `prv_review_video_flags`.
- Grafana's Telegram contact point has the bot token and chat id (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, GitHub secrets). Today only the `grafana` service receives them.
- Tables come from `sequelize.sync()`; the Go side writes tables Node defines (`prv_ai_confirmations` is the latest example).

## Goals / Non-Goals

**Goals:**
- An audit that never changes what anyone is served or what a verdict did.
- Findings whose numbers are computed, never written by the model.
- A record complete enough to re-read why a ping was sent (inputs as metrics, the raw answer, the prompt sha).

**Non-Goals:**
- A general rules engine or configurable thresholds: the rule constants live in Go, a change is a code change.
- Any per-finding UI: hide is per audit; per-finding state (and "Do it") comes with the actions change.

## Decisions

**Go subcommand, not a Node job or a Mac routine.** `ai audit` reuses the cron and flock pattern, the env loading, the Messages client, the fixture transport, prices and the heartbeat. A Node `setInterval` would be a second scheduler inside the API process. A Claude Code routine on the owner's Mac needs the Mac on and cannot read prod (prod reads go through the owner's terminal). Cron line: `45 * * * * flock -n /tmp/ai-audit.lock /app/prv/commands/ai/ai audit`, at minute 45 so it never starts with the judge (minute 30).

**Due batches in one query.** Finished (`cardinality(finished) >= reviews_needed`), `locked_by IS NULL`, some finisher `<> 'bayanovea'`, `max(decided_at)` between `NOW() - 7 days` and `NOW() - 30 min`, and `max(v.id) > COALESCE(latest audit watermark, 0)`. The watermark is the batch's newest verdict id: ids only grow, so a verdict saved after the read is newer and makes the batch due again. The 7-day window keeps the first switched-on tick from auditing (and pinging) the whole history. Older batches go through the manual run. The owner code is a constant `OWNER_REVIEWER = 'bayanovea'` in Go and in `prv/repository/review.js` (it is seeded in `REVIEWERS`). The owner, 2026-11-01: the block exists to keep the assessors' page quiet, not as access control, so the constant is enough.

**One consistent read per batch.** Each batch is read in its own `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction: items, every verdict of the batch, the finishers and the latest video flags of its native_ids. A judge item's decision, author and reason come from its `flagged_by` line (`judge <decision> by <by>: <reason>`), which the judge writes from its judgement, so no `prv_ai_judgements` read is needed. No row locks are taken, so neither the review page nor `applyVerdict` ever waits on an audit. The model call runs after that transaction ends. The insert of the audit row is its own short transaction. Lock order: none; the audit locks no `video_calculateds`, AI or batch row.

**Rules in Go, constants named.** `minRubberStampVerdicts = 10`, `rubberStampGap = 20 s`, `agreementOwnerBelow = 0.8`, `blindSampleMax = 12`, Wilson 95 % lower bound for keep shares. An item's source is read from its `flagged_by` first line (judge / served / hidden / second / admin) or `kind = 'sheet'`, the same text the review page already parses for the judge reason. "Keep" = `sponsor` | `self_promotion`. For a `sponsor+self_promotion` proposal any keep matches (no `category_flip`). `judge_false_alarm` groups items by `video_id` and needs all of that video's items in the batch to be kept. The judge puts a video's items into one part, so the group is complete.

**The model adds, never edits.** Input: batch name, its metrics, the rule findings as JSON, and per item its code, proposed category, bounds (player format), cues cut to 600 characters, source line, and every finisher's latest verdict with comment and bounds. Prompt `ai/prompts/audit-v1.md` (product-owned, `AI_AUDIT_PROMPT`, default `/app/ai/prompts/audit-v1.md`); structured output `{summary, findings: [{kind: comment|other, severity, items, text, action: {type, note}}]}`, `max_tokens` 8192 (2048 cut off the first prod answer, a 27-item batch with Russian findings). The Go side drops a finding with no item code or a code outside the batch, cuts `text` to 400 characters, and records the dropped count in metrics. Model `AI_AUDIT_MODEL` (default `claude-sonnet-5-5`, the judge's default; owner, 2026-11-01: same model as the judge). Transport `AI_CLIENT` like the judge (`anthropic` / `messages` = Messages API, `fixture` = `<batch>.audit.json` in `AI_FIXTURE_DIR`). The audit has its own small Messages client (`ai/audit/llm.go`, the judge's call shape) rather than a client shared with the judge: sharing would change the judge's package and tests for about forty lines. Alternative rejected: let the model write every finding from the raw data. It would then also produce the numbers the owner acts on, with no check.

**Failure split.** A transport error leaves no row and counts a failed batch, so the next tick retries; as with the judge, `CalculatorFailedVideos` then fires within the hour. An answer that fails the schema writes the row with the rule findings and `llm_error`. Retrying would buy the same answer, and the rule findings are what pings matter most for.

**Table `prv_review_audits`** (`ReviewAudit` in `prv/db/index.js`, by `sync()`): `id`, `batch` (indexed), `watermark` (INT, newest verdict id), `items`, `metrics` JSONB, `findings` JSONB (each with `new`), `summary`, `model`, `prompt_sha`, `raw_output`, `usage` JSONB, `cost_usd`, `llm_error`, `created_at`, `notified_at`, `hidden_at`, `hidden_by`. `new` is computed at insert against the batch's previous row: a finding is new unless that row has one with the same `kind` and the same sorted `items`. Only `notified_at` and `hidden_*` are ever updated.

**Owner block.** `reviewRepository.ownerAudits()`: per batch the latest row (`DISTINCT ON (batch) … ORDER BY batch, id DESC`) where `hidden_at IS NULL` and some finding has `new` and severity `owner` | `backlog`. Shown on `/admin/review` above the sections only when the reviewer is `OWNER_REVIEWER`; the JSON gets `audits` only then. Hide: `POST /admin/review/audits/:id/hide?verifyBearerToken=…` with body `{reviewer}`. It is 403 unless the reviewer is the owner, and 404 for an unknown id. It sets `hidden_at = NOW(), hidden_by` where `hidden_at IS NULL` (a second hide is a no-op, 200). Text goes through `escapeHtml`, as the comments do. Strings live in `prv/locales/review/{ru,en}.json`. `normalizePath`: `/admin/review/audits/#id/hide`.

**Telegram from Go, not through Grafana.** The tick posts `sendMessage` (plain text, no `parse_mode`, so comment text cannot inject markup) to `TELEGRAM_API_URL` (default `https://api.telegram.org`, overridable for tests) with `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, the alerting chat (owner, 2026-11-01: a ping in Telegram, once per new finding). The message carries the batch, the summary and each new `owner` / `backlog` finding (`[owner] A3, A4: …`), cut to 4000 characters, and the path `/admin/review?reviewer=bayanovea` without a host or token. After the send it sets `notified_at`. Each tick first resends rows of the last 7 days with `notified_at IS NULL` that have a new owner/backlog finding (a failed send counts a failed batch). The ping has its own switch, `AI_AUDIT_TELEGRAM` (default `off`): the first prod run (2026-11-01) found Telegram unreachable from the host, so the audit runs page-only until that is fixed (owner, 2026-11-02: go on without Telegram). The 7-day bound keeps switching the ping on later from sending every page-only audit since. Alternative rejected: a Grafana alert on a gauge of open findings. One alert instance per batch would need its own policy route with a huge `repeat_interval`, the message would be a template without the finding text, and resolve notices would double the pings. The cost is two more variables for the app: `docker-compose.yml` passes them to `app`, the deploy workflow already exports both, and `init_env.sh` adds `TELEGRAM_[A-Z_]+` to `/app/.env`.

**Heartbeat and cost.** `ai_audit` through `calculator.WriteHeartbeatStatus`; switch off → `ClearHeartbeat`. `CalculatorStale` gets `or (time() - … {provider="ai_audit"}) / 7200`; the infrastructure stat gets an `ai_audit` override like `ai_judge`. Cost: `costOf('audit', 'prv_review_audits')` in `prometheus-wrapper.js`, so `ai_cost_usd_24h` and `AiCostDaily` include it. The AI dashboard's two cost totals and the cost-per-day series add the table.

## How it could serve a wrong segment

It cannot: the audit writes only `prv_review_audits` and a Telegram message, reads under a read-only transaction, and neither `applyVerdict`, `ai regate`, the judge nor serving reads the new table. The e2e test checks that an audited ai batch leaves its AI rows, items and verdicts unchanged.

## Risks / Trade-offs

- [Comments and cues are untrusted text sent to the model] → the output is schema-bound and code-checked, it is shown only to the owner, escaped on the page and sent as plain text, and it drives no action.
- [A rubber-stamp finding on an honest fast reviewer] → it only suggests a blind subset; the owner decides. The evidence carries the median and the share so the owner can judge.
- [Telegram credentials wrong] → every tick counts a failed batch and `CalculatorFailedVideos` fires. That alert also goes through Telegram, so a broken bot is visible only on the dashboard heartbeat stat. Accepted: the same bot already carries every alert.
- [The 7-day window drops a batch that finished while the switch was off for a week] → the manual run covers it.
- [A re-audit shows old findings again] → `new` against the previous row keeps them out of the block and the message.

## Migration Plan

1. Deploy with `AI_AUDIT_ENABLED` unset: `sync()` creates the table, the cron line runs and exits at once, nothing is sent.
2. Owner runs `ai audit <batch>` on one recent finished batch inside the app container, checks the block and the message.
3. Owner sets the repository variable `AI_AUDIT_ENABLED=on` and redeploys with the running sha.

Rollback: the previous image never reads `prv_review_audits` (the table stays; a later roll-forward finds it), and its crontab has no audit line, so the `ai_audit` heartbeat row ages and `CalculatorStale` fires. The existing rollback note's `DELETE FROM calculator_heartbeats WHERE provider LIKE 'ai_%'` covers it. The Telegram variables in the app env are unused by an old image.
