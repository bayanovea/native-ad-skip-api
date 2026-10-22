---
worth: later
where: ai/pipeline/queue.go (claimOne), ai/pipeline/publish.go
added: 2026-10-22
---
# A video with an AI row cannot be detected again

`ai detect <native_id>` refuses a native_id that already has a `prv_ai_video_calculateds` row, and the cron queue never takes one, so a new prompt or model applies only to videos detected after it. A re-detect replacing the row would break what refers to it: vote ratings (by exact bounds), kind='ai' review items and their verdicts (an old item's keep verdict would splice its bounds into the new data, `applyVerdict`), the judge's counters, and a withdrawal by review / admin (a publish must never serve such a row again without a human).

What a re-detect needs: run ids on review items (or ignore items created before `published_at`), ratings recomputed from votes at publish, the judge's `judged_at` / `judge_counters` reset, the old row withdrawn when the new run ends `timeline_unreliable` / `no_track` / `failed`, and a decision whether a withdrawn row may be re-detected at all. Worth it once a prompt change is good enough to re-run the published videos.

From the 2026-10-22 review of the AI-first branch (`docs/plans/completed/20261022-ai-first-segments.md`).
