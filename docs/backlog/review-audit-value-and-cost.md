---
worth: later
where: prv_review_audits (cost_usd, findings, hidden_at), ai/audit/llm.go
added: 2026-11-02
---
# Is the API-paid batch audit worth what it costs

`ai audit` replaced the owner's "check these batches" in a Claude Code session (subscription, no API cost) with one Sonnet 5.5 Messages call per finished batch on `ANTHROPIC_API_KEY`. Estimate of 2026-11-02: $0.02–0.05 a quiet batch, up to ~$0.10 with findings (first prod run: 27 items, 8 512 input tokens, cut off at 2 048 output, $0.0375), so ~$3–8 a month at 2–5 batches a day, ~$15 at worst. Unknown that settles it: after 2–4 weeks with `AI_AUDIT_ENABLED=on`, the actual spend (`ai_cost_usd{kind="audit"}`, `SUM(cost_usd)` of `prv_review_audits`) against what the model part added beyond the free rule findings: how many `comment` / `other` findings led to an owner action, a backlog item or a rule change, and how many audits were hidden unread. If the model's findings rarely matter, keep the rules and drop the call (or call it only for batches with comments); if they do, keep it.
