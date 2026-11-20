# Tasks

## 1. API: event types, storage, limits

- [x] 1.1 `prv/db/index.js`: models `IntervalSkip` → `{provider}_events_interval_skip` (`user_id`, `prv_user_id`, `video_native_id`, `duration` INT NULL, `category_id`, `start`, `end`, `via` TEXT) and `IntervalOverrun` → `{provider}_events_interval_overrun` (same identity fields, `delta`, `after` INT), both with indexes `(video_native_id, category_id, start, "end")` and `("createdAt")`; `IntervalUndo` gains `via` TEXT NULL and `duration` INT NULL. `lib/schema.js` `syncSchema()`: `ADD COLUMN IF NOT EXISTS` for the undo tables of the three prefixes and `CREATE INDEX IF NOT EXISTS` on their bounds and time. Verify: `make test-e2e` boots on a fresh DB and on a DB created before the change (the e2e suite's second boot), `\d prv_events_interval_undo` shows the columns and indexes.
- [x] 1.2 `prv/routes/events.js`: `413` for a body over 100 events before validation; `interval_skip` (`via` in `auto` | `suggested`), `interval_overrun` (`delta`, `after` integers ≥ 0), `interval_undo` with optional `via` in `button` | `seek`, optional integer `duration` on all three; valid events grouped by type and written with one `bulkCreate` per type under the existing `tryHandle`; `time_saved` branch unchanged. Verify: `test/e2e.js` new `events:` tests — the mixed batch (rows with `duration`, `via`, `delta`, `after`), the old-client undo (NULLs), the invalid `via` skipped while the rest is stored, 101 events → `413` and no row, the same batch on `/yt/events` → `yt_events_*`; `make test-e2e`.
- [x] 1.3 `api/doc/openapi.yaml`: the three `/events` entries list the new types and fields with `via`, `delta`, `after`, `duration`; `docs/reference/routes.md` `events.js` entry and CLAUDE.md Routes line updated. Verify: `GET /api/doc` serves the YAML (e2e `api doc` test still green); `grep -c interval_overrun api/doc/openapi.yaml` = 3.

## 2. Judge: skips counted, undo evidence switchable

- [x] 2.1 `ai/judge/signals.go`: `Counters.Skips` (`skips`), counted by `events()` on `prv_events_interval_skip`; `undo` keeps counting every `via` (no filter). `ai/judge/llm.go`: the `<signals>` line for undo adds `per N skips` when `skips > 0`; `ai/prompts/judge-v1.md` legend names `skips` (times the player skipped the segment) and the rate. Verify: `ai/judge` unit tests (sqlmock) for the new query and the request rendering with and without skips; `go test -mod=vendor ./ai/...`.
- [x] 2.2 `prv/commands/ai/main.go` + `ai/judge/judge.go`: `AI_JUDGE_UNDO_EVIDENCE` (unset / `on` / `off`, else exit 1 naming it) passed into the judge config; `rules.go` `Evidence.negative()` and the due-videos query ignore undo when off; reason `no negative signal (undo counted only)`. Verify: `rules_test.go` cases (off + undo only → ok; off + undo + down vote → needs LLM; on unchanged); `test/e2e.js` `ai judge:` new test with `AI_JUDGE_UNDO_EVIDENCE=off` per run (undo only → `ok` by rules, no item, `signals.new.undo` recorded; a down vote on the same video → LLM) and the invalid value → exit 1; existing judge tests untouched and green; `make test-e2e`.
- [x] 2.3 Wiring: `docker-compose.yml` (`AI_JUDGE_UNDO_EVIDENCE`, empty = code default) and both lists of `.github/workflows/deploy.yml` (env and the `printf %q` exports). Verify: `docker compose config` shows the variable; `grep -c AI_JUDGE_UNDO_EVIDENCE .github/workflows/deploy.yml` = 2.

## 3. Dashboards

- [x] 3.1 `grafana/dashboards/product-stats.json`: row "Сигналы" — skips, undos (by `via`) and overruns per day; undo rate per day (undo / skips) with the share of `via = seek`. Verify: each SQL run against the local dump (`localhost:5433`) with seeded `prv_events_*` rows; `python3 -m json.tool` parses.
- [x] 3.2 `grafana/dashboards/ai-pipeline.json`: in the judge row — undo rate on AI entries (join `prv_ai_video_calculateds.data` by exact bounds) vs human segments (`prv_calculated_segments`) per week; top 20 videos by undo rate with ≥ 20 skips (link to `/admin/video/:id` through the `verifyBearerToken` variable); overruns per AI entry with `delta` median. Verify: SQL on the local dump with seeded rows; JSON parses; `docs/reference/metrics.md` lists the panels.

## 4. Client (`~/Web/vk-ad-skip-v2`, its own commits; plan `docs/plans/20261120-user-signal-events.md` there records the applied diff)

- [x] 4.1 `shared/api/endpoints.ts`: key `events.batch`, path `/events`, `POST`, `contextPlacement: 'query'`; `shared/api/types.ts`: `SignalEventDto` union (`interval_skip` | `interval_undo` | `interval_overrun`, fields of spec `user-signal-events`); `shared/api/events.ts`: `sendEvents(events, { keepalive })` adds `user_id` and the platform account id to every event and never throws; `shared/api/AGENTS.md` lists them. Verify: `shared/api/http.test.ts` / new `events.test.ts` — the array body stays an array, `v` goes to the query, each event carries the ids; `pnpm test`.
- [x] 4.2 `core/events/bus.ts`: `segment/undo` (`via: 'button' | 'seek'`, bounds) and `segment/suggestion-taken` (bounds) events; `notificationsController.ts` emits them from `rewindToStart` and `skipToEnd` (click and Enter paths). Verify: `ui/components/modals/mount.test.ts`-style unit test on the controller or a bus spy; `pnpm test`.
- [x] 4.3 `core/segments/segment-runner.ts`: `lastSkip` record on each performed skip; `seeking` listener (design decision 3) emits `segment/undo` via `seek` (target inside a skipped segment within 30 s) or `segment/overrun` (`delta` 3–120 s forward, within 10 s of landing, position within 10 s after the landed end), one each per skip; the button undo marks `lastSkip` undone. Verify: `segment-runner.test.ts` — seek back in time, seek back late, seek forward right after landing, ordinary seek later, one per skip; `pnpm test`.
- [x] 4.4 New `core/telemetry/` (`queue.ts`, `signals.ts`, `index.ts`): bus subscriber → DTOs (skip per segment of a bundle with `via: 'auto'`, suggestion-taken → `via: 'suggested'`, undo, overrun; `duration` from `videoService.state.playback.duration`); queue max 100 oldest dropped, flush at 20 / 60 s timer / `visibilitychange` hidden + `pagehide` with `keepalive`; started from `entrypoints/content/index.ts` after settings init, only with `telemetryOptIn`, detached (queue dropped) when the setting turns off. Verify: `queue.test.ts` with fake timers — the idle-viewer, tab-closed, switch-off and nothing-queued scenarios; `pnpm test`, `pnpm compile`, `pnpm lint`.
- [x] 4.5 Guidance and records: `core/AGENTS.md` (telemetry module), `AGENTS.md` module map, `TODO.md` (the two p0 lines removed, `time_saved` noted as derived server-side), `CHANGELOG.md` entry, `docs/backlog/vk-firefox-data-consent.md` note that skip / undo / overrun events fall under the categories already listed. Verify: `/guidance-check` of the client repo passes; `git diff --stat` shows only the listed files.

## 5. Docs

- [x] 5.1 CLAUDE.md: Routes (`events.js` types), Database Models (`IntervalSkip`, `IntervalOverrun`, undo `via`), Environment Variables (`AI_JUDGE_UNDO_EVIDENCE (on)`), AI-first segments (undo evidence switch, skips), the Wiring line; `docs/reference/models.md` (the two tables, the undo columns), `docs/reference/ai-first.md` judge paragraph (skips, the switch, `no negative signal (undo counted only)`), `docs/reference/metrics.md` (panels). Verify: every env variable in CLAUDE.md appears in `docker-compose.yml`; `grep -n AI_JUDGE_UNDO_EVIDENCE CLAUDE.md docs/reference/ai-first.md` hits both.
- [x] 5.2 `docs/ai-first-overview/{ru,en}.html`: if the judge section names undo as a trigger, add that with the switch off undo is recorded only and that skips are counted; header date updated, both artifacts republished (ru `6NZNwDcYKbLV5MUgKPwc8n`, en `SQhQy8xEPoY8XaxvKL4d6o`, `style.css` inlined). Verify: both pages open with the new date; skip with a note in the commit if the pages do not mention undo.
- [x] 5.3 Backlog: delete `docs/backlog/client-events-never-arrive.md`; file `events-tables-retention.md` (size estimate from design Risks, candidate rule: drop skip rows older than N months once the judge has read them). Verify: `ls docs/backlog` reflects both.

## 6. Cleanup

- [x] 6.1 Cleanup pass before commit: `grep -rn "interval_click\|time_saved" prv/routes/events.js docs CLAUDE.md` names only what stays; no leftover constants in the client from drafting; design Open Questions still open and nothing else; `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `make test-e2e`, and in the client `pnpm test && pnpm compile && pnpm lint` all green.

## Workflow follow-up

- API deploy first (push to `main` on the owner's "push"); set `AI_JUDGE_UNDO_EVIDENCE=off` as a repository variable
  in the same deploy (Run workflow, `image_tag` = the sha) so undo stays data only from the first row.
- Client release after the API is live (version bump, store review); until then no event arrives.
- Day-after check: `prv_events_interval_skip` / `_undo` / `_overrun` row counts and `via` split on prod, the
  `product-stats` row, `ai judge` heartbeat fresh with 0 failed and no judgement whose only new signal is undo.
- Archive after the owner confirms the prod check: `openspec: archive user-signal-events (verified on prod YYYY-MM-DD)`.
- Next iteration (separate change): thresholds on undo / skips and overrun, re-marking or review items from them,
  switching `AI_JUDGE_UNDO_EVIDENCE` back on.
