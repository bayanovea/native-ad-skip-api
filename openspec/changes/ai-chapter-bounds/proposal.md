# Proposal

From the backlog item `docs/backlog/ai-chapters-from-video-timeline.md`, in the shape the owner chose on 2026-11-02 after checking three chapter / AI disagreements in the player, not the item's earlier "a chapter becomes an entry by itself".

## Why

A served AI entry's bounds come from the auto subtitle track, rounded inward to whole seconds; the author's own chapters (the timecodes in the description, which yt-dlp already returns for prv) sit on the video's timeline and caught the ad's visual parts that subtitles cannot see. In the owner's check the chapter timing was exact on 2 of 3 videos, and the third chapter ran 16:48–25:05 for an ad that ended at 18:03, so a chapter is trusted only when it agrees with the detector, never alone. On a random 99 prod `published` rows (dump 2026-10-28), 25 have chapters; of the 36 served entries on them, 10 (on 5 videos) have both edges within 10 s of a chapter and would take its bounds, and 3 sit under an ad-titled chapter with one edge far off, which is what an assessor should settle. The gain is timing, not recall: every ad chapter in the sample already had a served `high` entry.

## What Changes

- **Chapters stored per run.** `ai detect` reads `chapters` (`start_time`, `end_time`, `title`) from the yt-dlp info JSON it already fetches and stores them on the `prv_ai_runs` row (new nullable JSONB column `chapters`; empty array when the video has none), whatever the switch says, so a batch answer resolved on a later tick finds them and the "ad chapter with no entry" count becomes a query.
- **Chapter check after the second opinion** (switch `AI_CHAPTERS_ENABLED`, default `off`). On publish, for each entry that would be served (after the confidence, length and second-opinion rules), by time only, no model call:
  - a chapter that overlaps the entry with both edges within `AI_CHAPTER_EDGE_SECONDS` (default 10) of the entry's → the entry is served at the chapter's bounds (whole seconds, inward), `source: "chapter"`, unless those bounds are shorter than `AI_MIN_SEGMENT_SECONDS` or overlap another served entry (then the AI bounds stay);
  - otherwise, a chapter that overlaps the entry with one edge within `AI_CHAPTER_EDGE_SECONDS`, the other further, and a title matching the ad keyword list (реклама, интеграция, спонсор, партнёр, промокод, скидка, erid, …) → the entry is served at its AI bounds and gets one `kind = 'ai'` review item (sheet `ai-chapter-<YYYY-MM-DD>`, codes `T<n>`, priority `important`) whose `flagged_by` names the chapter; the keyword only decides whether an assessor looks, it never changes what is served (owner, 2026-11-02);
  - anything else → nothing changes.
- **Review page offers chapter bounds.** On an ai item whose run has chapters, the item page lists the chapters overlapping the transcript window with a button that fills the verdict bounds with the chapter's (new bounds source `chapter`). Chapters are the author's public timecodes, not detector output, so they are shown before a verdict (the blind rule covers `flagged_by` only).
- **Visible state.** The publish log line counts entries moved to chapters and items sent; `/admin/video/:video_id` shows a "chapter" badge next to the existing "review" one; the AI dashboard gets a row on chapters (runs with chapters, entries served at chapter bounds, open `T` items, ad chapters with no entry).
- **Switches** wired through `docker-compose.yml`, the deploy workflow's two lists and `init_env.sh`; both default off / code default.
- Docs: CLAUDE.md, the AI-first overview pages ru/en and their two artifacts (served bounds may now come from the author's chapters).

## Capabilities

### New Capabilities
- `ai-chapter-bounds`: video chapters as a bounds source for AI entries: what is stored per run, when an entry takes a chapter's bounds, when it goes to review instead, how the switch gates it, and how the review page offers chapter bounds.

### Modified Capabilities
(none: `ai-verdict-application` is untouched, a verdict on a `T` item is applied as on any ai item; a keep with the chapter's bounds moves the entry by today's rule.)

## Impact

- Go: `ai/pipeline/` (new `chapters.go`: parse, match, review items; `detect.go`: parse in `fetch`, store in `startRun`, read in `poll`, apply in `finish` after `entries()`; config), `prv/commands/ai/main.go` (env). No synced eval package changes: the chapters are read from the raw info JSON `ytdlp.Runner.Info` already returns.
- Node: `lib/schema.js` (ALTER `prv_ai_runs ADD COLUMN chapters`), `db.js` (model), `prv/repository/review.js` (`BOUNDS_SOURCES` gains `chapter`; chapters in the item payload), `prv/routes/admin-review.js` + `prv/locales/review/{ru,en}.json` (chapters list, fill button), `prv/routes/admin.js` (badge).
- Ops: `docker-compose.yml`, `docker-compose.e2e.yml`, `.github/workflows/deploy.yml`, `infrastructure/init/init_env.sh`, `grafana/dashboards/ai-pipeline.json`.
- Tests: Go unit tests under `ai/pipeline`, `test/fixtures/ai/*.info.json` with chapters, `test/e2e.js` (`ai chapters:`), `make test-unit` for the review page parts.
- Behaviour with the switch on: some served entries change bounds by up to `AI_CHAPTER_EDGE_SECONDS` at each edge; review load grows by about 3 items per 100 published videos (sample estimate). No change with the switch off beyond the stored chapters.

## Out of scope

- Rows published before the check (`docs/backlog/ai-chapters-backfill-published-rows.md`): a yt-dlp fetch per old row from the prod host.
- An ad chapter with no AI entry becoming an entry or a review item (`docs/backlog/ai-ad-chapters-without-ai-entry.md`); this change only stores what that item needs to be counted.
- Classifying chapter titles with a model, or giving the chapter list to the detector prompt (eval-repo work).
- Chapters on hidden entries (confidence, short, unconfirmed): they are not served, and a keep verdict already carries bounds.
- Telling the judge that an entry's bounds came from a chapter: its signals are keyed on the entry's bounds, which stay exact.
- Subtitle drift on a video (case B: chapter ends 22:58, ad text runs to 23:54), still open with the owner (`docs/backlog/ai-timeline-phase-3.md`).
