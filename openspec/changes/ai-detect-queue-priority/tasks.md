# Tasks

## 1. Queue order (Go)

- [x] 1.1 `ai/pipeline/queue.go`: `queueMaxAge` constant (14 days); the `seen` branch of `queueRule` gains `AND first_seen_at > NOW() - INTERVAL '14 days'`; `claimQueued`'s select becomes the design's query: the channel CTE (`split_part(native_id, '_', 1)`, `n`, `served`, `latest_served` → `factor`), the score expression as `ORDER BY score DESC, first_seen_at, native_id`, `$1` / `$2` reused for the value terms; the `fetching` update and `queued_by` unchanged. Comment only the non-obvious: why the value terms are the admission terms, why age divides. Verify: `go vet ./ai/...`, `go test -mod=vendor ./ai/pipeline -run ClaimQueued`.
- [x] 1.2 `ai/pipeline/queue_test.go`: the `ORDER BY first_seen_at` expectation becomes the score order (`ln(`, `/ (1 +`, `0.3`, `1.5`, `0.5`, `INTERVAL '14 days'` present, `ORDER BY` … `DESC, first_seen_at, native_id`); the budget and empty-queue tests unchanged. Verify: `go test -mod=vendor ./ai/pipeline`.
- [x] 1.3 `lib/schema.js`: check `\d videos` on the local dump (localhost:5433); when `native_id` has no index, `CREATE INDEX IF NOT EXISTS videos_native_id ON videos (native_id)` next to the other idempotent DDL. Verify: `node scripts/sync-db.js` against the dump twice (second run a no-op); `EXPLAIN` of the claim query on the dump uses it.

## 2. End-to-end (`test/e2e.js`, fixtures `test/fixtures/ai/`)

- [x] 2.1 `ai detect: the queue takes the highest score first (views, requests, freshness, channel history, human markup) and leaves a video older than 14 days`: seed `prv_ai_videos` rows with placeholder ids on three channels (one with an AI row with entries, one with two empty AI rows, one unknown) and `first_seen_at` set by SQL (today, 3 days, 15 days), one with a live sponsor markup through `POST /markup`; run the tick with `AI_BATCH_MAX=1` repeatedly (fixture client, canned `.info.json` / `.ru.vtt` / `.detect.json` per id) and assert the claim order from `prv_ai_videos.status` / `updated_at` after each run; the 15-day row stays `seen` after the queue is empty; `ai detect <15-day id>` still takes it. Verify: `make test-e2e`.
- [x] 2.2 The existing `ai detect: queue → fetch → gate → batch → publish` test still passes with its three videos (their order may change: assert by id, not by position, where it does). Verify: `make test-e2e`.

## 3. Dashboard (`grafana/dashboards/ai-pipeline.json`)

- [x] 3.1 Queue stat "В очереди сейчас" (id 24) and the funnel "Стадии обработки сейчас" (id 15): the `seen` eligibility gains `AND first_seen_at > NOW() - INTERVAL '14 days' /* queue.go queueMaxAge */`; the expired rows fall into stage 1 ("ждут порога") unless a new stage is cleaner (then "2а. Не дождались" between 1 and 2, the funnel's stage list in CLAUDE.md updated). Verify: SQL run against the local dump with a seeded 15-day row; `python3 -m json.tool` on the file; the `/* AI_MIN_VIEWS */` … literals untouched.
- [x] 3.2 Two new panels in row 2: bar gauge "В очереди по просмотрам" (eligible rows per `width_bucket` band, NULL views as "только по запросам") and stat "Не дождались (старше 14 дней)". Verify: both SQLs on the seeded dump; JSON parses; `.claude/skills/ai-dashboard-check/check.py` still finds "В очереди сейчас" (run `check.py` against the public dashboard once deployed).

## 4. Docs

- [x] 4.1 CLAUDE.md: `ai detect` ("oldest `first_seen_at` first" → the score, the factors, the 14-day cut, the constant), Dashboard (the cut literal, the two panels, the stage change if any), Ops nothing. Verify: `grep -n "oldest" CLAUDE.md` finds no queue wording.
- [x] 4.2 `docs/ai-first-overview/{en,ru}.html`: the "Fetch the platform's subtitles" node and the extension bullet say the detector takes the videos with the most viewers and the most likely ads first and that a video not reached in two weeks is skipped; header date; republish both artifacts (`style.css` inlined, cross links kept). Verify: both pages open, dates match, artifact urls unchanged.
- [x] 4.3 `docs/backlog/ai-publish-date-from-clients.md` (new, backlog skill format): the extension sends the page's publication date text next to `views_text`; a `published_text` / `published_at` pair parsed as `views_text` is; the freshness term uses it when present. `docs/backlog/ai-detect-queue-outgrows-budget.md`: a dated note that the order change answers its 2026-11-04 line and that the item closes at archive (the expired count on the dashboard is the new watch). Verify: both files render; frontmatter fields as the skill wants.

## 5. Cleanup

- [x] 5.1 Cleanup pass: `grep -rn "oldest first\|ORDER BY first_seen_at" ai/ CLAUDE.md test/` finds only what is meant; no transient notes in CLAUDE.md; open questions (none expected) listed in the archive commit message. Verify: `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `make test-e2e` green.

## Workflow follow-up

- Deploy on the owner's "push" (push = prod deploy). No switch to flip: the order is live from the first tick.
- Day-after prod check: `docker logs --since 24h` has `ai detect:` claims whose first ids are high-view videos (compare with "В очереди по просмотрам"); `queue_now` from the `ai-dashboard-check` skill; "Не дождались" count; `CalculatorFailedVideos` quiet; the claim query's time in Postgres `pg_stat_statements` if enabled, else the tick's duration in the logs.
- A week later: share of empty answers (stage 9 of the runs since the deploy) against the 60 % before; the expired count against the 500k–1M inflow. The owner decides on the budget / `AI_MIN_VIEWS` from that.
- Archive after the owner confirms the prod check: `openspec: archive ai-detect-queue-priority (verified on prod YYYY-MM-DD)`; delete `docs/backlog/ai-detect-queue-outgrows-budget.md` in that commit.
