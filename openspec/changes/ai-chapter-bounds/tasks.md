# Tasks

## 1. Schema and Node side

- [x] 1.1 `lib/schema.js`: `ALTER TABLE prv_ai_runs ADD COLUMN IF NOT EXISTS chapters JSONB`; `db.js` `AiRun` model gains `chapters`. Verify: `node scripts/sync-db.js` against the local dump (localhost:5433) adds the column and a second run is a no-op.
- [x] 1.2 `prv/repository/review.js`: `BOUNDS_SOURCES` gains `chapter`; `getTranscript` returns `chapters` (`[{start, end, title}]` of the AI row's run overlapping the window, `[]` without) inside `transcript` (null for sheet items as before); `admin-review.js` `PAGE_BOUNDS_SOURCES` gains `chapter`. Verify: e2e test 5.3 (payload and a saved `bounds_source = 'chapter'`); `recordVerdict` still rejects an unknown source (existing e2e case).
- [x] 1.3 `prv/routes/admin-review.js` + `prv/locales/review/{ru,en}.json`: a chapter list above the transcript (title, `formatPlayerTime` bounds, a "use these bounds" button per chapter that fills both inputs and sets the bounds source to `chapter`; disabled with the inputs on `not_ad` / `unclear`); new keys in both locales. Verify: `make test-unit` (`test/i18n.test.js` parity), e2e test 5.3 checks the HTML.
- [x] 1.4 `prv/routes/admin.js`: a "chapter" badge for `source === 'chapter'` next to the "review" one. Verify: e2e test 5.1 reads it from `/admin/video/:video_id`.

## 2. Go pipeline

- [x] 2.1 `ai/pipeline/detect.go` `Config` + `ConfigFromEnv`: `ChaptersEnabled` (`AI_CHAPTERS_ENABLED=on`), `ChapterEdge` (`AI_CHAPTER_EDGE_SECONDS`, int ≥ 1, default 10, else a startup error naming it). Verify: `detect_test.go` cases for unset, `on`, `0`, `abc`.
- [x] 2.2 `ai/pipeline/chapters.go`: `chapter` type, `parseChapters(raw []byte) []chapter` (a failure is logged, returns nil), `adTitle` regexp (case-insensitive list of design.md), `applyChapters(served []Entry, chapters []chapter, edge, minSeconds int) ([]Entry, []chapterMatch)` (both edges → chapter bounds inward, `source: "chapter"`, skipped when shorter than `minSeconds` or overlapping another served entry; else one edge near + `adTitle` → a review match; smallest total edge distance wins). `chapters_test.go`: every scenario of the spec's two chapter requirements (both near, title ignored, overlap, short, smallest distance, one edge + ad title, one edge + topic title, no edge near, empty chapters). Verify: `go test -mod=vendor ./ai/pipeline -run Chapter`.
- [x] 2.3 `ai/pipeline/detect.go`: `fetch()` keeps the raw info and puts `parseChapters` into `pending`; `startRun()` writes `chapters` (`[]` when none); `poll()`'s `LATERAL` select reads `run.chapters`; `finish()` takes the chapters and, with `ChaptersEnabled`, runs `applyChapters` between `entries()` and `publish()`, then (after the second opinion's `record()`) sends the matches as `T<n>` items in `ai-chapter-<UTC date>`, priority `important`, through `review.Add` with the `flagged_by` of design.md; the publish log line gains `, C on chapters, R chapter items` when the switch is on. `detect_test.go` (sqlmock): the run insert carries the chapters, `finish` with the switch off publishes the AI bounds and adds no item, with it on publishes the chapter bounds and inserts the item after the AI row. Verify: `go test -mod=vendor ./ai/pipeline`.
- [x] 2.4 `ai/review/review.go` package comment lists the chapter check as a caller. Verify: `go vet ./ai/...`.

## 3. Wiring

- [x] 3.1 `docker-compose.yml` (`AI_CHAPTERS_ENABLED=${AI_CHAPTERS_ENABLED:-off}`, `AI_CHAPTER_EDGE_SECONDS=${AI_CHAPTER_EDGE_SECONDS:-}`), `.github/workflows/deploy.yml` (both lists: env from `vars.*` and the `printf %q` exports); `infrastructure/init/init_env.sh` needs nothing (it copies every `AI_*`, confirm by reading it); `docker-compose.e2e.yml` unchanged (the `ai chapters:` tests pass the switch per run). Verify: `docker compose -f docker-compose.yml config` shows both on `app`.

## 4. Dashboard

- [x] 4.1 `grafana/dashboards/ai-pipeline.json`: a row "4в. Главы" after "4б": runs with chapters / without (since the column exists), entries served at chapter bounds (`source = 'chapter'` in `data` of rows not withdrawn), open `T` items (`ai-chapter-%` without a verdict), `T` verdicts by kind, and "ad chapters with no entry" (latest run per AI row, chapters matching the keyword list tagged `/* chapters.go adTitle */` that overlap nothing in `data` ∪ `hidden`), with a table linking `native_id` and `video_id` as the other rows do. Verify: every new SQL run against the local dump (localhost:5433) with seeded runs, AI rows and items; `python3 -m json.tool` on the file; no env-tagged literal changes (none of `AI_MIN_VIEWS`, `AI_MIN_REQUESTS`, `AI_DAILY_BUDGET_VIDEOS` is touched).

## 5. End-to-end tests (`test/e2e.js`, fixtures `test/fixtures/ai/`)

- [x] 5.1 Fixtures: one new placeholder id with `.info.json` carrying chapters (one matching an entry at both edges, one ad-titled matching another at one edge, one topic chapter), `.ru.vtt`, `.detect.json`. `ai chapters: with AI_CHAPTERS_ENABLED=on an entry agreeing with a chapter at both edges is served at the chapter's bounds (source chapter, badge on /admin/video), an ad-titled one-edge chapter leaves the AI bounds and creates a T item in today's ai-chapter batch (important), a topic chapter changes nothing`. Verify: `make test-e2e`.
- [x] 5.2 `ai chapters: with the switch off the same video is published at the AI bounds with no item, and its run stores the chapters`. Verify: `make test-e2e`.
- [x] 5.3 `ai chapters: the T item page lists the chapter with a fill button; a keep with bounds source chapter moves the entry to the chapter's bounds (source review)`. Verify: `make test-e2e`.

## 6. Docs

- [x] 6.1 CLAUDE.md: AI-first segments (`ai detect` publish paragraph: the chapter step after the second opinion; a "Chapters" bullet with the rule, the `T` items, the owner's reasons), Routes → `admin-review.js` (chapter list, bounds source `chapter`) and `admin.js` (badge), Database Models (`AiRun.chapters`, `AiVideoCalculated` source `chapter`, `ReviewItem` `T<n>` / `ai-chapter-<date>`, `ReviewVerdict` bounds source `chapter`), Environment Variables (two new) and the Wiring paragraph, Dashboard (row 4в). Verify: every name in the text exists in the diff (`grep` each).
- [x] 6.2 `docs/ai-first-overview/{ru,en}.html`: served bounds may come from the author's chapters when they agree with the AI; what a `T` item asks the assessor; the "updated" date. Republishing both artifacts (`6NZNwDcYKbLV5MUgKPwc8n`, `SQhQy8xEPoY8XaxvKL4d6o`, `style.css` inlined, cross-language links) waits for the deploy (Workflow follow-up): the pages are shared with the assessors. Verify: both files carry the new section and date.
- [x] 6.3 `ai-chapters-backfill-published-rows.md` and `ai-ad-chapters-without-ai-entry.md` point at the chapter check and the stored chapters / dashboard row instead of `ai-chapters-from-video-timeline.md` (that item, with its uncommitted eval measurements, is deleted at archive). Verify: `grep -rn ai-chapters-from-video-timeline docs CLAUDE.md` finds only the item itself.
- [x] 6.4 Before reporting done: `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `make test-e2e`, `go vet ./...` all green. Verify: their output.
- [x] 6.5 Cleanup pass before commit: leftover names (`grep -rn "AI_CHAPTER\|ai-chapter-\|source: \"chapter\"" --exclude-dir=vendor`) consistent, no transient state in the artifacts, the open question (default edge) left only in design.md. Verify: `openspec validate ai-chapter-bounds --strict` passes.

## Workflow follow-up

- Deploy with `AI_CHAPTERS_ENABLED` unset; check that new runs store chapters (dashboard row 4в) and nothing served changed; republish both overview artifacts from the repo files.
- The owner sets the repository variable `AI_CHAPTERS_ENABLED=on` and redeploys with `image_tag` = the running sha.
- Day-after check: entries served at chapter bounds, open `T` items, the publish log lines (`ai detect: … on chapters`); a few chapter-bound entries checked in the player.
- Archive after the owner confirms the prod check; the archive is the record (`docs/backlog/ai-chapters-from-video-timeline.md` is already deleted, 2026-11-04: its open parts are `ai-chapters-in-detector-prompt.md` and `ai-ad-chapters-without-ai-entry.md`).
