# Tasks

## 1. Queue rule and trigger (Go)

- [x] 1.1 `ai/pipeline/detect.go`: rename `FallbackRequests` → `MinRequests` read from `AI_MIN_REQUESTS` (default 20), `AI_MIN_VIEWS` default 500000; `ai/pipeline/detect_test.go` `TestConfigFromEnv` asserts the new defaults and that `AI_FALLBACK_REQUESTS` is ignored.
- [x] 1.2 `ai/pipeline/queue.go`: `queueRule` becomes `views_max >= $1 OR requests >= $2`; the claim UPDATE and `claimOne` set `queued_by` with COALESCE as in design.md; `ai/pipeline/queue_test.go` regexes and expectations updated, plus a case for a row with known low views and enough requests.
- [x] 1.3 `ai/pipeline/detect.go`: drop the yt-dlp view gate in `fetch()` (`checkViews` parameter, `viewCount`, the `views_max` UPDATE) and the callers' argument; delete `TestViewCount`, `TestFetchWithoutViewCountPassesOnRequests`; `go test -mod=vendor ./ai/...` and `go vet ./...` green.

## 2. Schema (Node)

- [x] 2.1 `lib/schema.js`: `ALTER TABLE prv_ai_videos ADD COLUMN IF NOT EXISTS queued_by TEXT NULL`; `db.js` `AiVideo` model gets `queued_by`; proven by the e2e in 3.1 reading the column.

## 3. End-to-end

- [x] 3.1 `test/e2e.js` `ai detect:` cases: fixture rows at 600000 views / 19 and 20 requests under the default thresholds; assert `-1_456000205` stays `seen` (19 requests), `-1_456000206` is published with `queued_by = 'requests'`, a views row gets `views`, a row at both thresholds gets `both`, the manual run gets `manual`, a retry keeps its value; the `AI_FALLBACK_REQUESTS: '1000000'` override at the full-path test becomes `AI_MIN_REQUESTS`; `make test-e2e` green.

## 4. Ops wiring and dashboard

- [x] 4.1 `docker-compose.yml` and `.github/workflows/deploy.yml` (env list and the `printf %q` exports): `AI_FALLBACK_REQUESTS` → `AI_MIN_REQUESTS`; verified by `grep -rn AI_FALLBACK_REQUESTS` returning only docs history.
- [x] 4.2 `grafana/dashboards/ai-pipeline.json`: constants `min_views` = 500000, `fallback_requests` → `min_requests` = 20; stage-1 targets (panels 15, 18, 21, 24 and the stage-1 description) on the new rule, panel 21 without the "N+" group; new bar gauge "Почему взяли в детектор" and time series "Запусков модели по дням: почему взяли" in row 2; every changed SQL run against the local dump with a seeded `queued_by` and `python3 -c 'import json; json.load(open(...))'` passes.

## 5. Docs

- [x] 5.1 `CLAUDE.md`: Trigger, `ai detect` claim rule, Environment Variables (`AI_MIN_REQUESTS`, defaults), Dashboard constants, Database Models (`AiVideo.queued_by`); `docs/backlog/ai-views-from-clients.md` updated (release out, fallback gone, what is left to watch); verified by reading them back against the code.
- [x] 5.2 `docs/ai-first-overview/{ru,en}.html`: the "how a video is picked" wording (views or requests, two thresholds) and the header date; republish both artifacts from the repo files per CLAUDE.md → AI-first segments.
- [x] 5.3 Cleanup pass before commit: no leftover `FallbackRequests` / `fallback_requests` / `checkViews` names (`grep -rn` over `ai prv lib grafana test docker-compose.yml .github CLAUDE.md`).

## Workflow follow-up

- After the deploy the owner creates the `AI_MIN_REQUESTS` repository variable (or relies on the default 20), deletes `AI_FALLBACK_REQUESTS`, and checks the new panel once the first ticks ran.
- Archive the change after the deploy is verified.
