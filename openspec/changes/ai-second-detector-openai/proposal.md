# Proposal

Owner's decision of 2026-10-30 (no backlog item): an OpenAI budget of about $100 a month becomes a second, blind opinion on what Claude detected, not extra detection throughput. The alternative (more videos a day) was rejected: at the measured ~$0.052 per video the budget adds ~60 videos a day, not a doubling, the detector queue is not budget-bound (`docs/backlog/` queue analysis of 2026-10-26), and it would serve segments of a model that never passed the held-out gate.

## Why

Every served AI segment today rests on one model's answer. The owner's rule is "only segments we are sure the viewer sees correctly, even at the cost of missed ads", and the cheapest independent check of that is a second model reading the same transcript: a segment both models found is served, a segment only Claude found goes to an assessor. The same mechanism measures OpenAI against the assessors' verdicts for free, which is the prerequisite for ever trusting it with detection.

## What Changes

- **Second opinion on publish.** When `AI_SECOND_CLIENT` is on, every answered video gets one synchronous OpenAI call with the same prompt, transcript rendering and JSON schema as the Claude call. A Claude segment that would be served is served only when an OpenAI segment of the same category overlaps it with IoU ≥ 0.3; otherwise it goes to `hidden` with the new reason `unconfirmed`. Entries hidden by confidence or length keep those reasons (the second opinion is checked first only for the entries that would reach viewers; a hidden one is never re-labelled).
- **Review item per unconfirmed entry.** Each `unconfirmed` entry gets one `kind = 'ai'` review item (sheet `ai-second-<YYYY-MM-DD>`, codes `D<n>`, priority `important`, placed like the judge's items), so a keep verdict serves it and a `not_ad` hides it for good, as on any ai item. Segments only OpenAI found become no entries: they are recorded on the confirmation row and counted on the dashboard.
- **Failure degrades to today.** An OpenAI transport error, an answer that fails validation against the transcript, or a missing key when the switch is on, is logged and recorded; the video is published from Claude's answer alone, as without the switch. Nothing waits on OpenAI.
- **Recording and cost.** One row per second call in a new table `prv_ai_confirmations` (run, model, raw output, usage, cost, error, per-segment agreement), the third cost kind (`confirm`) on `/metrics` and in the `AiCostDaily` sum, a "second opinion" row on the AI dashboard (calls, agreement share, unconfirmed entries, failures, OpenAI-only segments, cost), the hidden-by-reason panel extended.
- **Switches** (all off by default, owner's env change only): `AI_SECOND_CLIENT` (`off` | `openai` | `fixture`), `AI_SECOND_MODEL` (default `gpt-6-luna`, owner 2026-10-30), `OPENAI_API_KEY`; wired through `docker-compose.yml`, the deploy workflow's two lists and `init_env.sh`.
- **`ai regate`** treats `unconfirmed` like `review`: never served by a rule, only by a keep verdict.
- **Eval first.** The OpenAI client (a `detector.Client` over the OpenAI API with structured output, key from `OPENAI_API_KEY` only) and an agreement measurement on the gold (how much recall the veto costs, at which IoU) are written and committed in `native-ad-skip-eval`, then synced here with `scripts/sync-detector.sh`. This change's product work starts from that sync.
- Docs: CLAUDE.md (AI-first segments, env, ops, model table), the AI-first overview pages ru/en and their artifacts (a segment is served when two models agree; what an assessor sees on a `D` item).

## Capabilities

### New Capabilities
- `ai-second-opinion`: the second-model confirmation of AI segments: when it runs, what it compares, what is served, hidden and sent to review, how a failure degrades, what is recorded and how the switches gate it.

### Modified Capabilities
(none; `ai-detect-queue` is untouched: which videos are taken does not change. `ai-verdict-application`: a keep on an `unconfirmed` entry serves it by today's generic rule for hidden entries, stated in the new spec, no existing requirement changes.)

## Impact

- `native-ad-skip-eval` (prerequisite, its own commit): `internal/detector/openai.go` (+ pricing rows), `adskip detect -client openai`, an agreement score; `go.mod` gains the OpenAI Go SDK.
- This repo: `scripts/sync-detector.sh` (drops nothing new; the key-file lookup is Anthropic-only), `go.mod` / `vendor/` (OpenAI SDK), `ai/detector/fixture.go` (a second-opinion fixture file suffix), `ai/pipeline/` (`confirm.go` new: the call, the IoU match, the confirmation row, the review items; `detect.go` calls it before `finish`; `publish.go` `reasonUnconfirmed`; `regate.go` sticky reason), `prv/commands/ai/main.go` (env), `lib/schema.js` (new table), `lib/ai-rules.js` (`HIDDEN_REASONS.UNCONFIRMED`), `prometheus-wrapper.js` (cost kind), `grafana/dashboards/ai-pipeline.json`, `docker-compose.yml`, `docker-compose.e2e.yml`, `.github/workflows/deploy.yml`, `infrastructure/init/init_env.sh`, `test/fixtures/ai/*.second.json`, `test/e2e.js`, Go unit tests under `ai/pipeline`, CLAUDE.md, `docs/ai-first-overview/{ru,en}.html`.
- Behaviour: with the switch on, fewer segments reach viewers until an assessor confirms them; review load grows by one item per unconfirmed entry (the eval's agreement measurement sizes it before the switch goes on). Cost: one OpenAI call per answered video, capped by the account's own monthly limit, visible in `AiCostDaily`.
- No change to votes, the judge, serving, the read path or existing AI rows: rows published before the switch are not re-checked.

## Out of scope

- Re-checking rows published before the switch went on (no backfill; `ai regate` never calls a model).
- OpenAI-only segments as hidden entries with their own review items (recorded and counted only; a later change when the agreement numbers justify the review load).
- Lowering the confidence threshold for segments both models found (`self_promotion` `medium`): a rule change after the agreement data is in, not here.
- A second opinion for the judge, or replacing the judge's model.
- An OpenAI Batch API transport (synchronous calls are within the budget; the detector's Claude call stays the batch).
- A per-day OpenAI budget in the code: the account's hard limit and the `AiCostDaily` alert are the cap.
