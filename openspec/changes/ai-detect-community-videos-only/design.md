# Design

## Context

`queueRule` (`ai/pipeline/queue.go`) starts with `native_id ~ nativeIDRegex`, where `nativeIDRegex = ^-?[0-9]+_[0-9]+$` is the "is a prv id" pattern shared with the read path (`PRV_NATIVE_ID` in `prv/repository/ai.js`) and the manual run's input check.

## Decisions

- **A separate constant `communityIDRegex = ^-[0-9]+_[0-9]+$` used only by `queueRule`**, rather than tightening `nativeIDRegex`: the shared pattern means "safe prv id for yt-dlp's URL" and stays as is for the read path and the manual run; the new one means "the tick may take it". One edit in the queue rule covers all three queue branches.
  - Rejected: a `LIKE '-%'` term only in the `seen` branch — a user upload already `queued` for a retry would keep spending fetches.
  - Rejected: stopping the read path from recording user uploads — loses the count the dashboard needs and the history a later rule change would want.
- **No env switch**: the owner states a product rule; the spend knobs stay `AI_MIN_VIEWS` / `AI_MIN_REQUESTS` / `AI_DAILY_BUDGET_VIDEOS`.
- **Dashboard**: funnel CASE gets `WHEN native_id !~ '^-' AND status IN ('seen', 'queued', 'fetching') THEN 0` first, a names row `(0, '0. Видео пользователя (id без «-»): AI не запускаем')`; panels 18, 19, 21, 24, 27, 30 add `AND a.native_id LIKE '-%'` (alias as in each query). SQL checked against the local dump with seeded rows, as for the previous change.

## Risks / Trade-offs

- [Some user uploads do carry integrated ads (bloggers posting from a personal page)] → the owner accepts missing them; stage 0 shows how many popular ones are skipped, so the rule can be revisited with data.
- [Archive order] → this delta ADDs to `ai-detect-queue`, which exists in `openspec/specs/` only after `ai-detect-trigger-views-or-requests` is archived; archive that one first.
