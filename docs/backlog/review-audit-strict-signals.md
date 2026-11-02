---
worth: yes
where: ai/audit/rules.go, ai/audit/llm.go, ai/prompts/audit-v1.md, prv/repository/review.js (ownerAudits)
added: 2026-11-02
---
# Audit: only strict signals reach the owner, soft findings are pooled and escalated as patterns

Owner, 2026-11-02, after the first prod tick (13 batches, 33 owner/backlog findings): what the block shows is too detailed and mostly doubts about single verdicts. The owner wants to see only strict signals that something is going wrong; the rest is collected, grouped by type, and brought to the owner only once a problem repeats. Do it right away, in a fresh session; build on the archived `review-batch-audit` (archive it first: verified on prod 2026-11-02, audits 2–15).

## Strict signals (the block, later the Telegram ping)

Two families, each a fixed rule with numbers, never a model opinion. Proposed rules, to confirm against the 15 prod audit rows before coding:

**Infrastructure / flow** (data that should be there is not):
- an `ai` item whose `video_id` has no `prv_ai_video_calculateds` row, or whose row's run has no transcript, or whose cues are empty: the assessor judged blind;
- an item whose `link` is not http(s), or that starts after the longest known duration of its native_id (`beyond_video_s`);
- a verdict that landed nowhere: the latest keep verdict of an `ai` item, but no entry in `data` / `hidden` at the item's effective bounds (applyVerdict missed it);
- a judge / review-withdrawn AI row whose every served entry is kept after `withdrawn_at` and that is still withdrawn (restore did not happen);
- the audit's own model call failing schema twice in a row (`llm_error` on consecutive audits).

**Assessor anomalies** (the batch's answers are not trustworthy as a whole):
- a uniform batch: ≥ 10 items and ≥ 90 % one verdict when that verdict is `unclear` or `not_ad`;
- the existing `rubber_stamp` (median gap < 20 s, all keeps, no bounds, no comment);
- a pace no one can watch at: median gap < 5 s whatever the verdicts;
- random-like answers: on items with a second reviewer, agreement < 60 %; or a reviewer's keep share on a source (served, judge, second, hidden) far below the other reviewers' share on the same source (95 % intervals disjoint, ≥ 10 items);
- the same comment text (normalised) on ≥ 5 items of the batch.

`eval_ready` is no anomaly: it leaves the block and becomes a count of pending eval imports in the digest below (open question for the session: or a separate to-do line).

## Soft findings (pooled, not shown one by one)

Everything else the rules and the model produce today (`category_flip`, `bounds`, `track_mismatch`, `judge_false_alarm`, `precision` info, every `comment` / `other` from the model) is stored as now, in `prv_review_audits.findings`, with a `topic` from a fixed list the prompt gives (e.g. dubbing credits, lead-in / return boundary, self_promotion vs sponsor, subtitle drift, judge re-cut rule, page / link problem) plus `other` with a short free name. A periodic digest (`ai audit digest`, daily) groups the soft findings of the last 30 days by topic and counts distinct batches, reviewers, videos and items; a topic that recurs (≥ 3 batches or ≥ 2 reviewers, ≥ 5 items; merge `other` names with one model call) becomes one **pattern** card for the owner with the counts, 3–5 example items with links, and the suggested action (rule for the assessors, prompt / detector change, backlog item). Hide on a pattern = seen; the same topic comes back only with new evidence. Single doubts never reach the owner.

## Notes

- The 11 audits hidden by hand on 2026-11-02 (ids 3–14 without 6: batches already checked in Claude Code sessions) are history for the digest, not new evidence.
- The Telegram ping stays off (`AI_AUDIT_TELEGRAM`) until `telegram-blocked-from-prod-host.md`; it should carry only strict signals and new pattern cards.
- Cost: the digest adds one small model call a day (`review-audit-value-and-cost.md`).
