---
worth: later
where: prv_ai_runs (input tokens, duration per video), grafana/dashboards/ai-pipeline.json ($/video panel)
added: 2026-10-26
---
# Prod detect costs $0.051 per video, the eval estimate was $0.025

Rollout week 1 (2026-10-24 → 26, 422 runs, v2.2, Sonnet 5.5, batch): $0.051 per video on the dashboard; the
held-out run read $0.025 ($5.41 / 217 videos) with the same prompt, model and transport. Spend is ~99% input
tokens, so the gap is transcript length: a hypothesis from an earlier session was long videos (streams) in the
prod queue, which the eval sets exclude (10–60 min). Not verified, and whether it holds for the whole queue or
for a few streams is unknown.

Check when more runs have accumulated (owner, not urgent): per run, input tokens vs video duration from
`prv_ai_runs` joined to `prv_ai_videos`; cost split by duration bucket (< 30 min / 30–60 / 60–120 / > 120). If a
few long streams carry the cost: a duration cap or a per-video token budget in `ai detect` (skip or truncate
streams > N h, log the reason) and the daily budget stays as is. If the price is uniform: the cue format in prod
differs from the eval (compare a prod request's token count with the eval's for the same video).

2026-10-28 (e4ab81c): prod `AI_DAILY_BUDGET_VIDEOS` 300 → 200 (~$10/day at ~$0.052) and the `AiCostDaily`
summary re-sized to 1.5× that day. That caps the spend at the observed price; it explains nothing, and if a few
streams carry the cost, the cap wastes most of the 200 slots on them.

Why it matters: the budget and the alert were first sized at $0.025–0.033 and are now sized to an unexplained
price; the week-2 go/no-go wants the price explained.
