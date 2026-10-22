---
worth: later
where: ai/judge/judge.go (record)
added: 2026-10-22
---
# AI judge cannot close a case without a human

Every LLM `withdraw` and `review` (and every `judge_invalid` answer) sends the video's AI entries to `/admin/review` as `kind='ai'` items; `withdraw` also unpublishes at once while `AI_JUDGE_AUTO_WITHDRAW` is on. Nothing lets the judge settle a case by itself, so the review queue grows with every negative signal. The plan's next step is a flag (off by default, like every `AI_*` switch) under which a judge `withdraw` closes the case without a review item, or a `review` with high-confidence `keep` flags skips the human.

Why `later`: it needs evidence first. Turn it on only after a few weeks of review verdicts on `ai-judge-*` batches show the judge's `withdraw` precision (export them with `scripts/export-review-verdicts.sh ai-judge-<date>` and compare with `prv_ai_judgements`). If the verdicts show it withdraws good segments, try Opus on the judge first (the plan's open question).

From `docs/plans/completed/20261022-ai-first-segments.md` (Key decisions → Judge, Post-Completion → Later).
