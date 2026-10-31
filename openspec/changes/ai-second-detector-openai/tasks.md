# Tasks

## 1. Eval repo first (`~/Web/native-ad-skip-eval`, its own commit)

- [x] 1.1 `internal/detector/openai.go`: `OpenAI` implementing `detector.Client` over the OpenAI Go SDK with structured output from `Request.Schema` (strict), key from `OPENAI_API_KEY` only, usage mapped into `detector.Usage`, stop/refusal → error as `resultFromMessage` does; `internal/detector/openai_test.go` (a recorded response parses; a cut-off answer errors; no key → error naming it). Verify: `go test ./internal/detector/`, and `TestProductPackagesImportOnlyEachOther` still passes.
- [x] 1.2 `internal/detector/pricing.go`: price rows for the OpenAI candidates (`gpt-5`, `gpt-5-mini`, `gpt-5.6-luna`, `gpt-6-luna`, `gpt-6.1-*`), dated in the comment. Verify: `detector_test.go` cost case for the new id.
- [x] 1.3 `cmd/adskip/detect.go`: `-client openai` builds the client; `go.mod` / `go mod tidy` for the SDK. Verify: `adskip detect -transport openai -model gpt-6-luna` on one video of the held-out set writes a run.
- [x] 1.4 Agreement score (`internal/score` or `cmd/adskip/agree.go`): for a first-model run and a second-model run on the same set, per video the first-model segments confirmed / unconfirmed at IoU 0.3 (same category), second-only count, and on the gold the recall the veto costs (gold ads the first model found and the second did not), reported at 0.5, 0.3 and 0.7. Verify: unit test on two hand-made outputs; one real run over the `2026-10-23-heldout-v22` set, the number recorded in the eval's run notes.
- [x] 1.5 Commit in the eval repo; record the commit sha and the agreement number in this change's design.md Migration Plan step 1. Verify: `git -C ~/Web/native-ad-skip-eval status --porcelain` empty.

## 2. Sync and dependencies

- [x] 2.1 `scripts/sync-detector.sh`: the version warning also covers the OpenAI SDK; run it against the eval checkout; `go get` + `go mod tidy` + `go mod vendor`; `ai/SOURCE` = the eval sha. Verify: `go build ./ai/...` and `go test -mod=vendor ./ai/...` green, `git status` shows `ai/detector/openai.go`, `vendor/`, `go.mod`, `go.sum`.
- [x] 2.2 `ai/detector/fixture.go` + `fixture_test.go`: a suffix constructor (`NewFixtureClientSuffix(dir, model, ".second.json")`), `<Key>.second-error` → error from `Detect`. Verify: `go test -mod=vendor ./ai/detector -run Fixture`.

## 3. Schema and Node side

- [x] 3.1 `db.js` model `AiConfirmation` (table `prv_ai_confirmations`, columns per design decision 2, unique `run_id`) and `lib/schema.js` (created by `sync()`, nothing to ALTER); `lib/ai-rules.js` `HIDDEN_REASONS.UNCONFIRMED = 'unconfirmed'`. Verify: `test/ai-rules.test.js` case for the new reason; `node scripts/sync-db.js` against the local dump creates the table.
- [x] 3.2 `prometheus-wrapper.js`: `costOf('confirm', 'prv_ai_confirmations')` in `ai_cost_usd` / `ai_cost_usd_24h`. Verify: `test/prometheus-wrapper.test.js` expects the third kind; e2e `ai second:` test (6.2) reads it on `/metrics`.
- [x] 3.3 `prv/routes/admin.js`: the hidden table shows `unconfirmed` as any reason (no code change expected; confirm by reading `entryRows`), `prv/repository/ai.js` `applyVerdict` comment lists the reason. Verify: e2e test 6.3.

## 4. Go pipeline

- [x] 4.1 `ai/pipeline/detect.go` `Config` + `ConfigFromEnv`: `SecondClient` (`AI_SECOND_CLIENT`: `off` | `openai` | `fixture`, else error), `SecondModel` (`AI_SECOND_MODEL`, default `gpt-6-luna`); `newDetectRun` builds `r.second detector.Client` (OpenAI: `detector.NewOpenAI(model)`, startup error without the key; fixture: 2.2) and its price. Verify: `detect_test.go` cases for the three values and the bad one.
- [x] 4.2 `ai/review` (new package): `Batch(tx, sheet, n)` and `InsertItem(tx, …)` moved out of `ai/judge/review.go` (the judge calls them; its tests unchanged). Verify: `go test -mod=vendor ./ai/judge/ ./ai/review/`.
- [x] 4.3 `ai/pipeline/confirm.go`: `confirm(ctx, nativeID, cues, first detector.Result) confirmation` (the call with the same `Request` as the first, `detector.Validate`, `detector.Resolve` both, IoU ≥ 0.3 same-category match → per-first-segment confirmed flags, `extra` count, usage/cost/error; failure → `gate: false` + error text + log `second opinion failed`); `writeConfirmation(tx, …)` the row; `addUnconfirmedItems(tx, …)` the `D<n>` items in `ai-second-<date>` with priority `important` through `ai/review`. `confirm_test.go` (sqlmock): agreement, category mismatch, low IoU, second-only, failure leaves the gate off, items inserted per unconfirmed entry. Verify: `go test -mod=vendor ./ai/pipeline -run Confirm`.
- [x] 4.4 `ai/pipeline/publish.go`: `reasonUnconfirmed`; `entries()` takes the confirmed flags (nil = no gate) and labels would-be-served unmatched segments `unconfirmed` after the confidence and length checks. `publish_test.go`: reason order (a low-confidence unmatched segment reads `confidence`), nil flags = today. Verify: `go test -mod=vendor ./ai/pipeline -run Entries`.
- [x] 4.5 `ai/pipeline/detect.go`: `submit()` (sync client) and `poll()` call `confirm` after the first answer validates and before `finish`; `finish` writes the confirmation row and the items in the publish transaction and logs `… published: N served, M hidden (U unconfirmed) of K segments`. Verify: `detect_test.go` ordering test (no network call while the queue row is locked: the fake client records the lock state) and the e2e tests of group 6.
- [x] 4.6 `ai/pipeline/regate.go` `place()`: `unconfirmed` sticky like `review` unless pinned. `regate_test.go`: threshold lowered keeps it hidden; a keep serves it. Verify: `go test -mod=vendor ./ai/pipeline -run Regate`.
- [x] 4.7 `prv/commands/ai/main.go`: nothing new to load (`.env` already carries every `AI_*`); `infrastructure/init/init_env.sh` grep adds `OPENAI_API_KEY`. Verify: e2e test 6.1 starts the binary with `AI_SECOND_CLIENT=fixture` from the container env.

## 5. Wiring and dashboard

- [x] 5.1 `docker-compose.yml` (`AI_SECOND_CLIENT=${AI_SECOND_CLIENT:-off}`, `AI_SECOND_MODEL=${AI_SECOND_MODEL:-}`, `OPENAI_API_KEY=${OPENAI_API_KEY:-}`), `.github/workflows/deploy.yml` (both lists: two `vars.*`, one `secrets.*`), `docker-compose.e2e.yml` unchanged: the `ai second:` tests pass `AI_SECOND_CLIENT=fixture` per run, so every other ai test and `ai defaults` run without it. Verify: `docker compose -f docker-compose.yml config` shows the three on `app`; e2e group 6 runs with the fixture client.
- [x] 5.2 `grafana/dashboards/ai-pipeline.json`: hidden-by-reason panel + `unconfirmed` column; a "Второе мнение" row (calls per day, confirmed share, unconfirmed entries, failures by normalised `error`, second-only segments, cost per day and 24 h) from `prv_ai_confirmations`. Verify: every new SQL run against the local dump with a seeded `prv_ai_confirmations` row (`psql` on localhost:5433), `python3 -m json.tool` on the file.

## 6. End-to-end tests (`test/e2e.js`, fixtures `test/fixtures/ai/`)

- [x] 6.1 Fixtures: `<id>.second.json` for a video with one agreeing and one unmatched segment plus one second-only segment, `<id>.second-error` for the failure video, a second answer for a video whose first answer is empty. `ai second: a segment both models found is served, one only Claude found is hidden unconfirmed with a D item in today's ai-second batch (important), a second-only segment is counted on the confirmation row, not an entry`. Verify: `make test-e2e`.
- [x] 6.2 `ai second: a failing second call publishes Claude's segments as today, records the error, counts no failed video; /metrics carries ai_cost_usd{kind="confirm"}`. Verify: `make test-e2e`.
- [x] 6.3 `ai second: a keep on an unconfirmed entry serves it, not_ad hides it as review; ai regate with a lower threshold leaves an undecided unconfirmed entry hidden; the admin page shows the reason`. Verify: `make test-e2e`.
- [x] 6.4 `ai defaults` test extended: with no `AI_SECOND_*` env no confirmation row is written and no `unconfirmed` reason appears. Verify: `make test-e2e`.

## 7. Docs

- [x] 7.1 CLAUDE.md: AI-first segments (`ai detect` publish paragraph, served vs hidden reasons, a "Second opinion" bullet), Ops (eval-first for the OpenAI client, the switch-on steps), Environment Variables (three new), Database Models (`AiConfirmation`), ReviewItem row (`D<n>`, `ai-second-<date>`, the shared `ai/review` package), Prometheus (`confirm` kind), Dashboard row, Deployment secrets list. Verify: every name in the text exists in the diff (`grep` each).
- [ ] 7.2 `docs/ai-first-overview/{ru,en}.html`: the serving rule (two models must agree), what a `D` item is for the assessor, the "updated" date; republish both artifacts (`6NZNwDcYKbLV5MUgKPwc8n`, `SQhQy8xEPoY8XaxvKL4d6o`) with `style.css` inlined. Verify: both pages open from the artifact links with the new date.
- [x] 7.3 `docs/backlog/`: one item each for the deferred paths (second-only segments as hidden entries with items; lower `self_promotion` threshold on agreement; an alert on second-opinion failures). Verify: files exist with the backlog skill's format.

## Workflow follow-up

- Deploy with every switch off; then the owner sets `OPENAI_API_KEY`, the account's $100 hard limit and `AI_SECOND_CLIENT=openai`, and redeploys with `image_tag` = the running sha.
- Day-after check: dashboard second-opinion row, open `D` items, `ai_cost_usd_24h{kind="confirm"}`.
- Archive the change after the prod check; move the design's decisions into `docs/plans/completed/` as the project's plan rules require.
