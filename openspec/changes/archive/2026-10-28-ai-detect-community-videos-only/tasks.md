# Tasks

## 1. Queue rule (Go)

- [x] 1.1 `ai/pipeline/queue.go`: add `communityIDRegex` (`^-[0-9]+_[0-9]+$`) and use it in `queueRule` instead of `nativeIDRegex`; `ai/pipeline/queue_test.go` regex on the claim query updated; `go test -mod=vendor ./ai/...` green.

## 2. End-to-end

- [x] 2.1 `test/e2e.js` `ai detect: queue → fetch → …` case: add a row `1_456000209` (no leading `-`) at 600000 views and 20 requests, assert it stays `seen` with `queued_by` NULL and no `prv_ai_runs` row; extend the manual-run case or add one to show `ai detect 1_456000209` claims it (fixture files for that id in `test/fixtures/ai/` if the stub needs them, placeholder id only); `make test-e2e` green.

## 3. Dashboard

- [x] 3.1 `grafana/dashboards/ai-pipeline.json`: funnel stage 0 and the community filter on panels 18, 19, 21, 24, 27, 30, as in design.md; each changed SQL run against the local dump with seeded positive / negative ids; the JSON loads.

## 4. Docs

- [x] 4.1 `CLAUDE.md`: Trigger / `ai detect` claim rule (community ids only, manual run excepted), Dashboard funnel (stage 0); verified by reading back against the code.
- [x] 4.2 `docs/ai-first-overview/{ru,en}.html`: one line on "community videos only, not personal uploads" in the subtitles step, header date; republish both artifacts per CLAUDE.md.
- [x] 4.3 Cleanup pass before commit (residue / transient state / open questions).

## Workflow follow-up

- Archive `ai-detect-trigger-views-or-requests` before this change.
- After the deploy, check stage 0 on the dashboard.
