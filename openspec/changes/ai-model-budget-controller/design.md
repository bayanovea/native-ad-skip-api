# Design

## Context

See proposal.md for the why. State on prod at 2026-11-19 (read-only queries):

- Recorded spend: OpenAI cycle since 11-10 $16.1 (1,457 terra runs); Anthropic cycle since 10-19 $106 (Sonnet detect
  until 11-05, Haiku confirmations 11-05 … 11-07, judge $0.4, audit $1). Per call: terra detect $0.012 (batch),
  Haiku confirm $0.0037, luna $0.0026, Sonnet detect $0.032.
- Reconciliation (owner, Anthropic console since 11-10): 135,386 input / 12,386 output tokens = $0.395 at Sonnet's
  price; recorded $0.380 (judge + audit), −4 %. The Sonnet path is priced right. Not covered: the long-input tier,
  unmodelled in `ai/detector/pricing.go` — 65 Haiku confirmations above 100K input tokens recorded $1.35, ~$5.4 at ×5.
- Flow: ~150 videos a day reach the thresholds (`AI_MIN_VIEWS` 500000, `AI_MIN_REQUESTS` 20); OpenAI's usable $180
  pays for ~500 a day, so the allowance is not the limit today. 97k videos wait `seen`.
- Debt: 4,346 rows published by terra with `AI_SECOND_ENABLED` off (2026-11-07 … 11-18), 6,226 served entries.
- The second opinion runs only in `finish()` (`ai/pipeline/confirm.go`); `prv_ai_runs.transcript` stores the meta and
  the cues the request was rendered from, so a later call can rebuild the request.
- The cost alert `AiCostDaily` and every other alert read Prometheus, not Postgres.

## Goals / Non-Goals

**Goals:**
- One place computes the budget (Go, `ai detect`); the dashboard and the alert read what it stored, never a second
  copy of the arithmetic.
- With the switch off, every code path behaves as today (the e2e suite without the variable proves it).

**Non-Goals:**
- Exact billing: the product's own cost is the measure; the owner reconciles with the consoles by hand.
- Fairness between kinds inside a vendor beyond the order below.

## Decisions

1. **Vendor cycles from the environment, UTC.** A cycle starts at 00:00 UTC on `AI_BUDGET_<VENDOR>_RESET_DAY`
   (1–28, so every month has the day). UTC because the `D` sheets' days and the vendors' usage pages are UTC; a
   subscription renewing at another hour shifts the pace by at most one day. Alternative: one global budget — rejected,
   the allowances are separate money that expires separately.

2. **Spend = recorded cost, summed per tick.** `SUM(cost_usd)` over `prv_ai_runs`, `prv_ai_confirmations`,
   `prv_ai_judgements`, `prv_review_audits` by `created_at` in the cycle, the vendor by model prefix (`claude-` =
   Anthropic, the rule `vendorOf` already applies; moved into the new package and called from `pipeline`). Runs still
   in a batch (`cost_usd` NULL, no `raw_output`) count at the vendor's average of its last 200 priced runs (fallback
   $0.02 when none). A few thousand rows a cycle: no index or cache needed.

3. **Today's cap = (usable − spent before today) / days left, today included.** Underspending yesterday raises
   today's cap, overspending lowers it, so the cycle converges on the usable amount without a separate catch-up rule.
   The cap is computed once at tick start; the tick adds each call's cost to today's spend in memory, so one tick
   cannot run past it. Alternative: a fixed daily cap (allowance / 30) — rejected, it leaves an under-flowing month's
   money unspent and cannot absorb the backlog pass.

4. **Order inside a vendor.** OpenAI: detect only. Anthropic: judge and audit are never held (counted only, ~$0.05 a
   day), then confirming new answers, then the backlog. A new video's confirmation is decided at `finish()`: room for
   one more call at the average confirm cost → call now; else publish unconfirmed. The backlog pass runs after
   `poll()`, so new answers always come first.

5. **Deferral publishes like the switch off** (owner, 2026-11-19: never hold detection for the second opinion; queue
   the check and catch up when there is money). No marker column: a row is in the backlog when it is published, not
   withdrawn, its run's detector vendor differs from the second model's vendor and it has no confirmation row. That
   rule also picks up the 4,346 rows of the switched-off days and leaves out the Sonnet-only rows of October (a same-
   vendor check: Haiku vetoes Sonnet's true ads five times as often as luna, eval stage 7). Alternative: a
   `confirm_pending` column set at publish — rejected, it would need a one-off to mark the old rows and says nothing
   the join does not.

6. **Backlog pass = a later `confirm()` and a narrow re-gate.** Per row, newest `published_at` first, at most 10 a tick
   (Haiku p95 ~18 s: ≤ 3 min inside the 5-min cron slot): read the run (transcript, raw output), call the second model
   outside any lock, then in one transaction re-read the row and gate only served entries. Each served entry is matched
   to the first-model prediction of its category with the largest overlap (a chapter-moved entry still overlaps its
   prediction); pinned entries stay (bounds set by review, or a latest ai-item verdict that is a keep:
   `judge.EntryKeepsAll`, the rule `ai regate` uses). Unconfirmed ones move to `hidden` with reason `unconfirmed` and
   lose their rating, then `record()` writes the confirmation row and the `D` items under the day's cap, unchanged.
   Shared code with `finish()`: `confirm()`, `agree()`, `record()`.

7. **Lock order of the backlog pass:** `publishLock` (the day's `D` count and numbering, as in `finish()`), then
   `video_calculateds` `FOR UPDATE`, then the AI row `FOR UPDATE`, then the batch row inside `review.Add`. This is the
   vote handlers' order (`video_calculateds` before the AI row) and `finish()`'s (advisory lock first, batch row last);
   the queue row is not taken. A row withdrawn or re-gated between the call and the transaction is re-read under the
   lock, so the gate applies to its current entries; a withdrawn one is skipped.

8. **State table `prv_ai_budgets` (one row per vendor), written by Go, defined by Node.** Like
   `calculator_heartbeats`: the model lives in `prv/db/index.js` so `sync()` creates it, Node never writes it. Columns:
   `vendor` PK, `allowance_usd`, `reserve`, `cycle_start`, `cycle_end`, `spent_cycle_usd`, `spent_today_usd`,
   `cap_today_usd`, `forecast_unspent_usd`, `backlog`, `updated_at`. The forecast is usable − spent − last 7 days'
   average daily spend × days left. Node exposes the rows on `/metrics` as `ai_budget_*{vendor}` gauges for the
   alert (alerts read Prometheus); the dashboard reads the table directly.

9. **Claim limit** in `claimQueued`: `min(AI_BATCH_MAX, AI_DAILY_BUDGET_VIDEOS − runs 24 h, floor((cap − spent
   today) / avg detect cost))` when the budget is on. The video count stays as a hard ceiling against a pricing bug
   (a zero price would otherwise make the cap pay for everything).

10. **Long-input tier in `detector.Price`:** a threshold and input / output multipliers per model, applied to the whole
    call when its input tokens pass the threshold. Eval repo first (its `pricing.go` and tests), then
    `scripts/sync-detector.sh`. Recorded costs from before stay as they are; the forecast uses the last 7 days, so it
    corrects itself within a week.

11. **Thresholds by hand first** (owner, 2026-11-19: the controller lowers them in the end; at first the owner sets them
    by Claude's instructions). Rule in `docs/reference/ops.md`: OpenAI's forecast unspent > 20 % of its usable amount
    three days running and the queue under a day's claims → `AI_MIN_VIEWS` one step down (500k → 300k → 200k →
    100k); the cap spent before 18:00 UTC three days running → one step up. Each step is a commit (the dashboard's
    `/* AI_MIN_VIEWS */` literals) and a deploy. The automation is `docs/backlog/ai-thresholds-from-budget.md`.

## Serving and precision

The change serves unconfirmed segments in one case: a deferred confirmation publishes the detector's segments alone
until the backlog pass reaches the row. That is the owner's decision (2026-11-19) and the state of every row since
2026-11-07; the backlog pass narrows it, newest rows first, so the time a new row serves unchecked is bounded by
Anthropic's daily cap, not by the next reset. A later confirmation never adds a served entry; it only moves served
entries to `hidden`, and never one an assessor kept or bounded.

## Risks / Trade-offs

- [The backlog hides 0.5–0.7 served entries a row, ~2,000 over the debt; only 30 `D` items a day] → the rest stay
  hidden unreviewed, as for any new row past the cap today; precision-first accepts the missed ads.
- [A pricing error over- or under-spends a whole cycle] → the video-count ceiling stays; the overrun alert at 1.5 ×
  cap + $1; the owner's console reconciliation every few days.
- [The cap estimates a batch's cost before it is priced] → in-flight runs count at the 200-run average; terra's per-
  video cost moves ±30 % with video length, so a day may land a few percent off, corrected by the next day's cap.
- [Anthropic's allowance runs out early (Max-plan usage outside this project)] → the second opinion defers, the
  detector keeps going, the backlog grows and is drained after the reset; the dashboard shows the backlog's age.
- [Backlog rows re-picked every tick after a transport failure] → a call with no answer costs nothing; an answer that
  fails validation writes its row and leaves the backlog.

## Migration Plan

1. Eval repo: long-input tier in `pricing.go` + tests; sync.
2. Deploy with `AI_BUDGET_ENABLED` off: nothing changes; the table appears empty; e2e covers both states.
3. Owner sets the six `AI_BUDGET_*` variables and `AI_BUDGET_ENABLED=on` (`AI_SECOND_ENABLED` already on since
   2026-11-19) and redeploys the running sha. First ticks: state rows, the claim limit, the backlog pass starting.
4. Day-after check: state rows fresh, Anthropic's spend today ≈ its cap, backlog shrinking, no tick failure, `D` cap
   held, the overrun alert silent.

Rollback: the previous image ignores `prv_ai_budgets` and the `AI_BUDGET_*` variables; confirmation rows written by
the backlog pass are ordinary rows; rows still waiting simply keep serving unconfirmed, as before this change. No data
needs undoing.

## Open Questions

- Answered: Haiku 5.5's long tier multiplies output too ($0.50 / $2.50 per MTok above 100K input tokens, ×5 both;
  eval `79dd2b2`, `pricing.go`'s comment).
- When the backlog is drained, whether the OpenAI-unspent forecast should first raise the detector's model tier
  instead of lowering thresholds — the eval track's answer, not this change's.
