# Design

## Context

See proposal.md for why. What shapes the how:

- The detector packages under `ai/` are copies of `native-ad-skip-eval/internal/` (`scripts/sync-detector.sh`); only `detector/fixture.go`, `fixture_test.go`, `apikey_test.go` are product-owned. A new transport is an eval change first. The eval has no OpenAI client today and no OpenAI dependency (`go.mod`: `anthropic-sdk-go` only).
- `detector.Client` is one interface (`Detect(ctx, Request) (Result, error)`, `Model()`); `Request` already carries the system text, the rendered user message and the JSON schema, so a second transport needs no change to the pipeline's request building (`detector.NewRequestFormat`, `requestFormat`).
- `ai/pipeline/detect.go` resolves answers in `finish()`, which runs inside one transaction holding the `prv_ai_videos` row `FOR UPDATE`. The read path upserts that row on every `GET /video-calculated` (`aiRepository.seen()`), so no network call may happen under that lock.
- `prv_ai_runs` is read by the budget count (`queue.go`), `poll()` (latest run per native_id), `regate --backfill`, the judge and the review page (`transcript` via `run_id`), the cost gauges and six dashboard panels. A second row per video there would touch every one of them.
- Hidden entries carry a `reason`; `regate.place()` recomputes reasons from the rules except `review`, which is sticky; `applyVerdict` (`prv/repository/ai.js`) serves a hidden entry on a keep whatever its reason and hides it as `review` on `not_ad` / `unclear`.
- Review items from Go: `ai/judge/review.go` (`addReviewItems`, `reviewBatch`) inserts items and batches with its own SQL; `prv/repository/review.js` `openPart()` is its JS twin.

## Goals / Non-Goals

**Goals:**
- One more gate between the first model's answer and `data`, precomputed at publish, nothing on the read path.
- The second model never adds a segment and never blocks a publish.
- Everything the second model said is kept, so its precision and recall against the assessors' verdicts can be computed later from the tables alone.

**Non-Goals:**
- A second transport inside the Claude batch flow (the second call is synchronous, per video).
- Any change to what the judge, the vote handlers or serving read (`data` is still exactly what is served).
- A generic N-model ensemble; two models, first-model bounds, that is all.

## Decisions

1. **Client in the eval repo, synced; OpenAI SDK as the transport.** `internal/detector/openai.go` implements `detector.Client` over the OpenAI API with structured output from `detector.Schema` (strict JSON schema; the schema already has `additionalProperties: false` everywhere), key from `OPENAI_API_KEY` only (no key-file lookup, so the sync script needs no stripping for it), `Model()` the exact id, usage into `detector.Usage` (cache fields from the API's cached-input count, write 0). `detector.Prices` gains the OpenAI rows used. `adskip detect -client openai` runs it on a set, and a new agreement score reports, on the gold, how many gold ads the first model found that the second did not at IoU 0.5 (the veto's recall cost) and the second-only count. *Alternative*: a product-owned `ai/detector/openai.go` in `PRODUCT_FILES`. Rejected: no eval number before the switch goes on, against the eval-first rule for anything that decides what is served.
2. **Own table `prv_ai_confirmations`, not a second `prv_ai_runs` row.** Columns: `id`, `run_id` (FK `prv_ai_runs`, unique: one confirmation per run), `video_id`, `native_id`, `model`, `prompt_sha`, `raw_output` JSONB, `usage` JSONB, `cost_usd`, `error` TEXT NULL, `confirmed` INT, `unconfirmed` INT, `extra` INT (second-only segments), `created_at`. Created by `sync()` through a Sequelize model (`AiConfirmation`) like the other `prv_ai_*` tables; no ALTER. *Alternative*: `prv_ai_runs` with a `role` column. Rejected: every reader listed in Context would need a filter, and `poll()`'s "latest run" would see the wrong row.
3. **The call happens before `finish()`, outside the lock.** `detect.go`: `submit()` (synchronous client) and `poll()` call `r.confirm(ctx, nativeID, cues, res)` right after the first answer validates and pass its result into `finish(...)`, which writes the confirmation row and the review items in the same transaction as the publish (lock order: queue row → `video_calculateds` → batch row, the judge's order from the AI row onward; `finish` never takes the AI row lock, the publish's `INSERT … ON CONFLICT` is the write). A first answer that fails validation gets no second call (nothing to confirm; the run is `failed` as today).
4. **Match rule: same category, IoU ≥ 0.3, on resolved seconds** (`detector.Resolve` for both outputs, before rounding), the question being "the same ad", not "the same edges" (0.3 since the measurement, see Migration Plan). Bounds served are the first model's: the eval score was measured on them.
5. **Reason `unconfirmed` is checked first and is sticky in `regate`.** In `entries()`: confidence → short → unconfirmed, so a segment that would not be served anyway keeps the reason it has today (the dashboard's "below threshold" stays comparable) and only would-be-served segments get the new one. In `place()`: `unconfirmed` joins `review` as a reason no rule moves; a keep verdict pins the entry as today (`judge.EntryKeepsAll`), after which the length rule applies. *Alternative*: a `confirmed` flag on every entry and the gate re-evaluated in `regate`. Rejected: one more field on the served shape for nothing the read path uses.
6. **Review items for unconfirmed entries, from `pipeline`, with the judge's SQL.** `confirm.go` inserts `kind = 'ai'` items the way `ai/judge/review.go` does (sheet `ai-second-<date>`, `D<n>`, `reviewBatch` placement, `reviews_needed` 1, priority `important`: not `urgent`, which the judge's withdraw-related items are, and above the below-threshold `optional` passes). `reviewBatch` and the item INSERT move from `judge` to a small shared package (`ai/review`) so the two callers do not drift; `review.js` `openPart()` stays the JS twin. `flagged_by`: `["second <model>: not found", "entry: <category> <confidence>, <len> s"]`. An entry that already has an open ai item cannot exist here (a fresh row), so no 409 path.
7. **Failure = today's behaviour, recorded.** Any error from the second call, or `detector.Validate` failing on its output, leaves `confirmed`/`unconfirmed`/`extra` NULL, fills `error`, logs `ai detect: <native_id> second opinion failed: …`, and `entries()` runs without the gate. Not a failed video of the tick (the first model answered; the owner chose degrade over hold). A missing `OPENAI_API_KEY` with `AI_SECOND_ENABLED=on` and the `openai` transport is a startup error of the tick, like `ANTHROPIC_API_KEY` for the first client: a misconfiguration should not silently run unconfirmed for a day.
8. **Fixture transport for tests.** `detector.FixtureClient` gets a file suffix (`NewFixtureClient(dir, model)` keeps `.detect.json`; `NewFixtureClientSuffix(dir, model, ".second.json")` for `AI_SECOND_CLIENT=fixture`), product-owned file, so the e2e drives the real binary with canned second answers and a `<native_id>.second-error` file for the failure path.
9. **Config.** `AI_SECOND_ENABLED` (`off` default | `on`, the owner's switch like `AI_DETECT_ENABLED`), `AI_SECOND_CLIENT` (`openai` default | `fixture`, the transport like `AI_CLIENT`; split from the switch on 2026-11-01), `AI_SECOND_MODEL` (`gpt-6-luna`), `OPENAI_API_KEY`; `Config` fields `SecondClient`, `SecondModel`; `init_env.sh`'s grep gains `OPENAI_API_KEY`; the deploy workflow's env and `printf %q` lists and `docker-compose.yml` gain the three (`AI_SECOND_CLIENT` and `AI_SECOND_MODEL` as repository variables, `OPENAI_API_KEY` a secret).
10. **Cost.** `detector.Price.Cost` with the OpenAI row; `priceFactor` 1 (no batch). `prometheus-wrapper.js` adds `costOf('confirm', 'prv_ai_confirmations')`; the `AiCostDaily` threshold stays (the OpenAI spend is bounded by the account's hard limit, which the owner sets to the $100).

## Risks / Trade-offs

- [The veto costs recall: every segment the second model misses waits for an assessor] → the eval agreement score is read before the switch goes on; the review load is one item per unconfirmed entry, sized by that number; `AI_SECOND_ENABLED=off` restores today's path for new videos at once (existing `unconfirmed` entries stay until a verdict or a keep, by design).
- [An OpenAI outage silently serves first-model-only segments] → the confirmation row's `error` and the dashboard's failure panel show it; no alert in this change (an outage is today's behaviour, not a regression).
- [Sequential synchronous calls lengthen the tick] → at `AI_BATCH_MAX` 5 that is five calls per tick, well under the 5 min cron; the manual run was synchronous already.
- [Two Go callers of the review tables (judge, confirm) drift from `review.js`] → one shared Go package, CLAUDE.md's ReviewItem row names all three.
- [The OpenAI SDK enters `vendor/`] → pinned in `go.mod`, same handling as `anthropic-sdk-go`; the sync script's version warning is extended to it.
- [Model id `gpt-6-luna` may be renamed or priced differently by the time the switch goes on] → the id is an env variable; the price row is looked up by id and an unknown id logs "no price" and records 0, as for Claude.

## Migration Plan

1. Eval repo: client, price rows, agreement score; commit (eval `d451056`, `8268050`, synced into `ai/SOURCE`). Measured 2026-10-31: `adskip agree 2026-10-23-claude-sonnet-5-5-v2.2-batch-nt 2026-10-31-gpt-6-luna-v2.2-openai-nt` (217 common held-out videos, reviewed gold, gold IoU 0.3; luna at effort medium, $0.0021 per video on eval transcripts):

   | IoU | served | unconfirmed | true ads vetoed | wrong cuts vetoed | second-only |
   |-----|--------|-------------|-----------------|-------------------|-------------|
   | 0.3 | 311 | 31 | 6 / 250 | 25 / 61 | 145 |
   | 0.5 | 311 | 53 | 24 / 250 | 29 / 61 | 180 |
   | 0.7 | 311 | 84 | 50 / 250 | 34 / 61 | 223 |

   Claude against itself (batch vs cli) at 0.5 vetoes 16 / 250 and 14 / 61: luna's veto is not noise. Luna marks far more self_promotion (276 of 493 segments), hence the second-only count.
2. `scripts/sync-detector.sh ~/Web/native-ad-skip-eval`, `go mod vendor`; product work per tasks.md; merge, deploy with every switch off (no behaviour change; the new table is created by `sync()`).
3. Owner: `OPENAI_API_KEY` secret, account hard limit at $100/month, `AI_SECOND_ENABLED=on` variable, deploy with `image_tag` = the running sha.
4. Day after: the dashboard's second-opinion row (calls, agreement, failures, cost), open `D` items on `/admin/review`.
5. Rollback: `AI_SECOND_ENABLED=off` (new videos take today's path); a code rollback to a pre-change image leaves `prv_ai_confirmations` and the `unconfirmed` reason in place, which that image treats as any hidden entry (never served, keep verdict serves it).

The IoU threshold was 0.5 (the judge's) until the measurement above; the owner set it to 0.3 on 2026-10-31: 0.5 vetoes 18 more true ads and only 4 more wrong cuts than 0.3, because the gap between them is boundary disagreement on real ads (both models found the ad, cut it differently), while the second model mostly does not see a wrong cut at all. Served precision is ~87% either way; review load ~29 vs ~49 `D` items a day at 200 videos. A later change of it is a spec change, not a tuning knob.
