# Proposal

## Why

The AI pipeline spends two monthly allowances that reset on different days (OpenAI on the 10th, Anthropic on the 19th)
and expire unused, yet its pace is one hand-set video count (`AI_DAILY_BUDGET_VIDEOS`) and its second opinion one
hand-set switch. The switch went off on 2026-11-07 when Anthropic ran short, so ~4,300 rows have been served on the
detector alone since, and nothing shows what is left of either allowance until a vendor refuses calls.

## What Changes

- Roles stay fixed (owner, 2026-11-19): OpenAI detects, Anthropic gives the second opinion and runs the judge and the
  audit. Models change only through the eval track; this change picks no model.
- New spend budget per vendor (`AI_BUDGET_ENABLED`, default off): allowance, reset day and reserve per vendor from the
  environment; spend = the product's own recorded cost since the cycle's reset. Each detect tick computes the vendor's
  cap for today (what is left of the usable allowance spread over the days to the reset) and stores it for the
  dashboard.
- The detector claims only as many videos as OpenAI's cap for today still pays for, under the existing
  `AI_DAILY_BUDGET_VIDEOS` and `AI_BATCH_MAX` limits, which stay as hard ceilings.
- The second opinion is deferred, not skipped, when Anthropic's cap for today is spent: the video is published on the
  detector alone and waits for its confirmation (owner, 2026-11-19: never hold detection back for the second opinion).
- Confirmation backlog: each detect tick confirms published rows that have none, newest first, while Anthropic's cap
  allows. This covers the rows deferred by the budget and the rows published with the switch off since 2026-11-07
  (owner, 2026-11-19). An unconfirmed served entry moves to `hidden` as `unconfirmed`, with a `D` item under the
  existing daily cap.
- Long-input pricing: the per-model surcharge above a prompt-size threshold (Haiku 5.5 above 100K input tokens,
  luna above 272K) enters the price table, so recorded cost matches the bill (eval repo first, then sync).
- Dashboard: a budget row per vendor (allowance, spent this cycle, left, days to reset, cap and spend today, forecast
  left unspent at the reset, the confirmation backlog) and a per-pair quality row read from signals the product
  already has (no new review items). An alert when a day's spend runs well past its cap.
- Thresholds: the forecast of unspent allowance is shown with a documented manual rule for lowering `AI_MIN_VIEWS`
  (the owner applies it at first); automating it is a follow-up change.

## Out of scope

- Choosing or switching models automatically, or a stronger OpenAI detector: a separate eval track (owner, 2026-11-19);
  the budget only paces.
- An A/B split between pairs or a blind sheet built for this change: quality is read only from signals that already
  flow (owner, 2026-11-19).
- The controller lowering `AI_MIN_VIEWS` / `AI_MIN_REQUESTS` itself: filed as a backlog item with the rule fixed here.
- Pacing the judge and the audit: they are counted in Anthropic's spend but never held back (~$1.5 a month).
- Reading balances from the vendors' consoles or admin APIs: the owner reconciles by hand.
- rt / yt: the `ai` command is prv-only; the budget is keyed by vendor, so later providers share it unchanged.

Comes from `docs/backlog/ai-second-opinion-old-rows.md` (the backlog pass) and supersedes
`docs/backlog/ai-detector-parallel-pairs.md` (roles are fixed, no second pair). Archive `ai-detector-roles-swap`
first: this change's `ai-second-opinion` delta builds on its version of that spec.

## Capabilities

### New Capabilities
- `ai-spend-budget`: per-vendor allowance cycles, today's cap, the detector's claim limit from it, the stored budget
  state, the dashboard budget row and the overrun alert.

### Modified Capabilities
- `ai-second-opinion`: the second call may be deferred by the budget; published rows without a confirmation are
  confirmed later by the detect tick, which moves unconfirmed served entries to `hidden`; the dashboard shows the
  backlog and the per-pair quality.
- `ai-detect-queue`: the tick's claim limit also obeys the detector vendor's cap for today when the budget is on.

## Impact

- Go: `ai/pipeline` (`queue.go` claim limit, `detect.go` tick order, `confirm.go` deferral and the backlog pass), a new
  `ai/budget` package (cycles, caps, state upsert), `ai/detector/pricing.go` via the eval sync.
- Node: a new `prv_ai_budgets` model in `prv/db/index.js` (created by `sync()`); no route change.
- Grafana: `grafana/dashboards/ai-pipeline.json` (budget and pair rows), `grafana/provisioning/alerting/rules.yml`.
- Env: `AI_BUDGET_ENABLED`, `AI_BUDGET_OPENAI_USD`, `AI_BUDGET_OPENAI_RESET_DAY`, `AI_BUDGET_ANTHROPIC_USD`,
  `AI_BUDGET_ANTHROPIC_RESET_DAY`, `AI_BUDGET_RESERVE` in `docker-compose.yml` and both lists of the deploy workflow.
- Docs: CLAUDE.md, `docs/reference/{ai-first,ops,models,metrics}.md`, `docs/ai-first-overview/{ru,en}.html`.
