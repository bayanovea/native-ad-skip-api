# Proposal

From `docs/backlog/ai-detector-roles-swap.md`, owner's decision of 2026-11-04: OpenAI `gpt-6.1-terra` becomes the detector through the OpenAI Batch API, and `claude-haiku-5-5` becomes the second opinion, so the detector runs on the $100/month OpenAI allowance (project `adskip-prod`) instead of the owner's Claude bill.

## Why

The owner's Claude bill caps throughput: 230 videos a day ≈ $7.5/day on Sonnet batch, with a queue of ~500 where inflow ≈ drain. The OpenAI allowance is mostly unused (the `gpt-6-luna` second opinion costs ≈ $0.6/day). With the roles swapped, the cost at 230 videos/day is ≈ $4.3/day on OpenAI (terra batch, $0.0093 a video on the eval's held-out set, ×2 for prod's longer transcripts as with Sonnet; ≈ $130/month, over the $100) and ≈ $1.1/day on Claude (Haiku, $0.0023 ×2). The product cannot do this today: the detector call is Anthropic-only (`AI_CLIENT` = `anthropic` | `messages` | `fixture`), the second opinion is OpenAI-only (`AI_SECOND_CLIENT` = `openai` | `fixture`), and neither `AI_MODEL` nor the detector's client reaches prod from the repository variables.

## What Changes

- **Eval first** (prerequisite, its own commits in `~/Web/native-ad-skip-eval`, steps 1–3 of the backlog item): an `openai-batch` transport in `internal/detector/` (the OpenAI Batch API through the vendored `openai-go/v3`, mirroring `anthropic_batch.go`), a `claude-haiku-5-5` price row, terra on the held-out set through that transport with an assessor sheet over its own stretches, scored against Sonnet v2.2 and held to the usual gate (SCORE ≥ 0.15, ≤ 6 s/h wrongly cut on reviewed gold), and `adskip agree` terra → Haiku 5.5 against luna's veto numbers. The product work starts only if terra passes the gate and Haiku vetoes at least something.
- **Detector transport switch `AI_DETECT_CLIENT`** (new, detect only): `anthropic` (Batches API on the cron tick, Messages in the manual run: today), `messages`, `openai-batch` (OpenAI Batch API on the cron tick, Chat Completions in the manual run), `openai` (Chat Completions always), `fixture`. Empty takes `AI_CLIENT`'s value, so today's prod, the e2e (`AI_CLIENT=fixture`) and every hand run behave as before. `AI_CLIENT` keeps meaning the judge's and the audit's client: setting it to an OpenAI value would stop both, which is why the detector gets its own variable.
- **Second-opinion transport `anthropic`**: `AI_SECOND_CLIENT` gains `anthropic` (synchronous Messages API, `ANTHROPIC_API_KEY`) next to `openai` and `fixture`.
- **A model that cannot go to its transport is a startup error** of a working tick: a `claude-*` model on an OpenAI transport, or a non-Claude model on an Anthropic one, for the detector and the second model alike, so a half-applied variable set fails loudly instead of having every submit rejected hourly.
- **A batch is resolved by the transport that submitted it**, chosen from the model recorded on the video's run, so the deploy that swaps the pair (and a rollback) neither loses the batches in flight nor marks the tick failed for up to 24 h; its cost is computed with that run model's price.
- **Wiring**: `AI_MODEL` and `AI_DETECT_CLIENT` join `docker-compose.yml` and both lists of the deploy workflow (`AI_SECOND_CLIENT` / `AI_SECOND_MODEL` are wired already); code defaults stay Sonnet batch → luna, so clearing the variables is the rollback.
- **Prices and dashboard**: the synced `claude-haiku-5-5` row; the second-opinion failure reasons panel learns the Anthropic error texts (credit balance, overloaded) next to the OpenAI ones.
- Docs: CLAUDE.md (env, AI-first summary, `ai/` row), `docs/reference/ai-first.md` (Second opinion, `ai detect` transport, Prompt), `docs/reference/metrics.md` (`AiCostDaily` arithmetic), `docs/ai-first-overview/{ru,en}.html` (which vendor reads the text first, which confirms) with both artifacts republished.

## Capabilities

### New Capabilities
- `ai-detect-transport`: which transport makes the detector's model call (switch values, cron batch vs manual synchronous, the fallback to `AI_CLIENT`), the model ↔ transport check, resolving each batch with the transport that submitted it, batch pricing, and what a rejected submit does.

### Modified Capabilities
- `ai-second-opinion`: the switch requirement names the new `anthropic` transport and its key; the dashboard requirement classifies failures of either vendor.

## Impact

- `native-ad-skip-eval` (prerequisite): `internal/detector/openai_batch.go` (+ test), `pricing.go`, `adskip detect -transport openai-batch`, the held-out run, its sheet and review, `score` / `paired` / `agree` numbers recorded in this change's design.md.
- This repo: `scripts/sync-detector.sh` run (`ai/detector/openai_batch.go`, `pricing.go`, `ai/SOURCE`), `ai/pipeline/detect.go` (`Config.Client` from `AI_DETECT_CLIENT`, the transport switch, the model check, per-run batch routing and price in `poll()`), `ai/pipeline/detect_test.go`, `docker-compose.yml`, `.github/workflows/deploy.yml`, `grafana/dashboards/ai-pipeline.json`, `test/e2e.js`, the docs above.
- Prod (owner, after the deploy with nothing switched): repository variables `AI_MODEL=gpt-6.1-terra`, `AI_DETECT_CLIENT=openai-batch`, `AI_SECOND_CLIENT=anthropic`, `AI_SECOND_MODEL=claude-haiku-5-5`, and `AI_DAILY_BUDGET_VIDEOS` against the $100 hard limit; a deploy with the running sha.
- Unchanged: the queue, the gates, publish, serving, votes, the judge and the audit (their client stays `AI_CLIENT`, their models `AI_JUDGE_MODEL` / `AI_AUDIT_MODEL`), the tables (the model is already on every `prv_ai_runs` / `prv_ai_confirmations` row), the prompt (v2.2 on both sides, as `ai-second-opinion` requires).

## Out of scope

- Running both pairs in parallel (Sonnet → luna on the owner's budget plus terra → Haiku on the $100, ~430 videos/day): a later, additive change with a second budget variable and a routing rule, after both pairs are proven.
- A separate prompt per model: only if the eval shows the need, then its own backlog item.
- An effort setting per side: the detector keeps `medium`; Haiku runs at its API default (`medium`), as the synced Anthropic client sends no effort to a Haiku model. A different level only if the eval's step 3 picks one.
- A batch transport for the second opinion, the judge or the audit (they stay synchronous Messages calls).
- A per-vendor spend cap in code: the OpenAI project's hard limit and `AiCostDaily` remain the caps.
- Changing the 24 h expiry of a waiting batch (both vendors' batch windows are 24 h; see design Risks).
