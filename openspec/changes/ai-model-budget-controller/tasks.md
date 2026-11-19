# Tasks

## 1. Long-input pricing (eval repo first, `~/Web/native-ad-skip-eval`, its own commit)

- [ ] 1.1 `internal/detector/pricing.go`: `Price` gains a long-input threshold and input / output multipliers, applied to the whole call when its input tokens (cache reads included) pass the threshold; rows for `claude-haiku-5-5` (100K) and `gpt-6-luna` (272K) from the vendors' pricing pages, the source and date in the comment (design Open Questions: whether Haiku's output is multiplied). Verify: `detector_test.go` cases below, at and above each threshold; `go test ./internal/detector/`.
- [ ] 1.2 `scripts/sync-detector.sh ~/Web/native-ad-skip-eval` here; `ai/SOURCE` = the eval commit. Verify: `go test -mod=vendor ./ai/...` green; `git diff ai/detector/pricing.go` shows only the synced change.

## 2. Budget package and state table

- [ ] 2.1 `prv/db/index.js`: model `AiBudget` → `prv_ai_budgets` (design decision 8; `vendor` PK; Node never writes). Verify: `make test-e2e` boots and the table exists (`ai budget:` test in 3.4 reads it).
- [ ] 2.2 New `ai/budget/` (`config.go`, `budget.go`): `ConfigFromEnv()` (`AI_BUDGET_ENABLED`, the four allowance / reset variables, `AI_BUDGET_RESERVE`; switched on with a missing or invalid one → error naming it), `Cycle(now, resetDay)`, `VendorOf(model)` (moved from `pipeline.vendorOf`, which now calls it), `Load(db, cfg, now)` → per vendor usable, spent before today, spent today, in-flight runs at the 200-run average, cap, average detect / confirm cost; `Allow(vendor, cost)`, `Spend(vendor, cost)`, `Save(db, backlog)` (upsert, forecast from the last 7 days). Verify: `ai/budget/budget_test.go` with sqlmock — the spec scenarios of `ai-spend-budget` (cycle boundaries incl. before the reset day and Dec→Jan, reserve, spend by vendor across the four tables, in-flight average and the $0.02 fallback, even-pace cap, overspent → 0, missing variable error).
- [ ] 2.3 `prometheus-wrapper.js`: `ai_budget_allowance_usd`, `ai_budget_spent_cycle_usd`, `ai_budget_spent_today_usd`, `ai_budget_cap_today_usd`, `ai_budget_updated_timestamp_seconds`, label `vendor`, from `prv_ai_budgets` (no rows → no series). Verify: `test/prometheus-wrapper.test.js` case with two rows and with none; `make test-unit`.

## 3. `ai detect`: pacing, deferral, backlog (`ai/pipeline/`)

- [ ] 3.1 `queue.go` `claimQueued`: with the budget on, the limit also takes `floor((cap − spent today) / avg detect cost)` for the detector's vendor (design decision 9); `detect.go` `newDetectRun` loads the budget config, `Detect` loads the state at tick start, the manual run ignores it. Verify: `queue_test.go` — room for two claims two, cap spent claims none, `AI_BATCH_MAX` still caps, budget off unchanged; `go test -mod=vendor ./ai/...`.
- [ ] 3.2 `confirm.go` / `detect.go` `finish` path: on a cron tick with the budget on, `confirm()` is skipped when the second model's vendor has no room for one call at its average; every made call's cost goes to `Spend`; the detector's cost too. Log line `second opinion deferred (budget)`. Verify: `confirm_test.go` / `detect_test.go` — deferred publish writes no confirmation row and serves every accepted entry; manual run still confirms; budget off unchanged.
- [ ] 3.3 New `ai/pipeline/backlog.go`: the backlog query (spec `ai-second-opinion`: published, not withdrawn, detector vendor ≠ second vendor, no confirmation row, newest `published_at` first, LIMIT 10), the call outside any lock, then the transaction in the order of design decision 7 (`publishLock`, `video_calculateds`, AI row, `review.Add`), the narrow re-gate (design decision 6: largest-overlap match, pinned entries via `judge.EntryKeepsAll` and `source: review`), rating dropped from moved entries, `record()` reused; transport error → nothing written, invalid answer → confirmation row with the error; runs after `poll()` in `tick()`, then `budget.Save` with the backlog count. Verify: `backlog_test.go` — every scenario of the two backlog requirements (not found → hidden + `D` item, kept by assessor stays, chapter-moved entry matched, row left empty not withdrawn, hidden entries untouched, withdrawn skipped, same-vendor row not picked, cap spent → none, 529 → nothing written, invalid → error row); `go test -mod=vendor ./ai/...`.
- [ ] 3.4 `test/e2e.js` `ai budget:` tests (fixtures, placeholder ids): budget off → today's behaviour and no state row; on with a tiny Anthropic allowance → publish deferred, no confirmation row, then a larger allowance on the next tick confirms it later and hides the entry the `.second.json` fixture lacks, with a `D` item; OpenAI cap spent → nothing claimed; `/metrics` shows the `ai_budget_*` series; a missing allowance variable → exit 1 naming it. Verify: `make test-e2e`.

## 4. Wiring

- [ ] 4.1 `docker-compose.yml` (`AI_BUDGET_ENABLED` `:-off` and the five others, empty = code default) and both lists of `.github/workflows/deploy.yml` (env and the `printf %q` exports); `docker-compose.e2e.yml` only if a test needs a default other than off. Verify: `docker compose config` shows the variables; `grep -c AI_BUDGET_ .github/workflows/deploy.yml` = 12.

## 5. Dashboard and alert

- [ ] 5.1 `grafana/dashboards/ai-pipeline.json`: row "Бюджеты" (per vendor from `prv_ai_budgets`: allowance, spent this cycle, left, days to reset, cap and spent today, forecast unspent with the 20 % warning, state age; spend this cycle by kind from the four cost tables); in row "4б" the backlog panels (waiting, oldest age, confirmed later per day: confirmation rows whose `created_at` is after the row's `published_at` by more than an hour) and the pair table (spec `ai-second-opinion` dashboard requirement). Verify: each SQL run against the local dump (`localhost:5433`) with seeded `prv_ai_budgets` rows; `python3 -m json.tool` parses the JSON.
- [ ] 5.2 `grafana/provisioning/alerting/rules.yml`: `AiBudgetOverrun` on the Prometheus gauges (spent today > 1.5 × cap + 1, or spent this cycle > allowance; no data = OK), Telegram contact point as the others; `AiCostDaily` stays. Verify: YAML parses; `docs/reference/metrics.md` lists the rule.

## 6. Docs

- [ ] 6.1 CLAUDE.md: Environment Variables (the six `AI_BUDGET_*`), the wiring list, AI-first segments bullet (the budget, deferral, backlog), Database Models (`AiBudget`), Key Directories (`ai/budget/`); `docs/reference/ai-first.md` (pacing, deferred second opinion, backlog pass with its lock order), `docs/reference/ops.md` (switching the budget on, the manual threshold rule of design decision 11, reconciling with the consoles), `docs/reference/models.md` (`prv_ai_budgets`), `docs/reference/metrics.md` (`ai_budget_*`, panels, alert). Verify: `grep -n AI_BUDGET_ CLAUDE.md docs/reference/*.md` hits every file named.
- [ ] 6.2 `docs/ai-first-overview/{ru,en}.html`: the budget and the deferred second opinion at the concept level, header "updated" date; republish both artifacts (ru `6NZNwDcYKbLV5MUgKPwc8n`, en `SQhQy8xEPoY8XaxvKL4d6o`; one file each, `style.css` inlined, cross-language links). Verify: both artifact URLs show the new date.
- [ ] 6.3 Backlog: new `docs/backlog/ai-thresholds-from-budget.md` (the controller applies design decision 11's rule itself; thresholds stored with the budget state so the dashboard's `/* AI_MIN_VIEWS */` literals go); delete `ai-second-opinion-old-rows.md` (done here) and `ai-detector-parallel-pairs.md` (roles fixed, owner 2026-11-19); `ai-second-model-revisit.md` points to the pair table. Verify: `ls docs/backlog | grep -c -e old-rows -e parallel-pairs` = 0.

## 7. Integration and cleanup

- [ ] 7.1 Full suite: `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `go vet ./...`, `make test-e2e`. Verify: all green.
- [ ] 7.2 Cleanup pass before commit: `grep -rn vendorOf ai/` only the wrapper; no leftover debug logs; transient state out of docs; open questions of design.md still open or answered. Verify: `git diff --stat` touches only files named above.

## Workflow follow-up

- Archive `ai-detector-roles-swap` first (its task 1.3 gate is superseded by the owner's 2026-11-19 decision to keep the roles; record that in its design and close it), then this change's specs build on it.
- Commit on the owner's "commit"; push only on the owner's "push" (push = prod deploy) with `AI_BUDGET_ENABLED` unset; check prod unchanged (no state rows, second opinion as before).
- Owner: `gh variable set` `AI_BUDGET_OPENAI_USD=200`, `AI_BUDGET_OPENAI_RESET_DAY=10`, `AI_BUDGET_ANTHROPIC_USD=100`, `AI_BUDGET_ANTHROPIC_RESET_DAY=19`, `AI_BUDGET_ENABLED=on`; Run workflow with `image_tag` = the running sha.
- Day-after prod check: state rows fresh each tick, Anthropic spend today ≈ its cap, backlog shrinking from ~4,300, `D` cap held, no `ai_detect` failure, `AiBudgetOverrun` silent; owner's console numbers against `spent_cycle_usd`.
- First threshold step by the rule in ops.md once the forecast warns three days running.
- Archive after the owner confirms the prod check: `openspec: archive ai-model-budget-controller (verified on prod YYYY-MM-DD)`, own commit.
