# Design

## Context

See proposal.md for why. What shapes the how:

- `ai/detector/` is a synced copy of the eval's `internal/detector/` (`scripts/sync-detector.sh`); a new transport is an eval change first. The eval has `OpenAI` (Chat Completions, strict JSON schema, `OPENAI_API_KEY` only) and `AnthropicBatch` (Submit / Poll / results loaded into a map, `Detect(Request{Key})` reads them), no OpenAI batch transport, and no `claude-haiku-5-5` price row (`pricing.go` has `gpt-6.1-terra` at $1 / $5 / $0.05 cached).
- `ai/pipeline/detect.go`: `Config.Client` comes from `AI_CLIENT`; `newDetectRun` builds `r.client` and, on the cron tick, `r.batch` (the `batchClient` interface: `Submit`, `Poll`); `priceFactor` 0.5 whenever `r.batch` is set; `r.price` is the current `AI_MODEL`'s row. `poll()` reads every `detecting` video with a `batch_id` and its latest run, polls through `r.batch` and reads answers through `r.client`; a poll error counts the batch's videos as failed for the tick's heartbeat. `finish()` prices with `r.price * r.priceFactor`. `expire()` fails a video `detecting` for more than 24 h.
- `ai judge` and `ai audit` read `AI_CLIENT` too and accept only `anthropic` | `messages` | `fixture`; their models are `AI_JUDGE_MODEL` / `AI_AUDIT_MODEL`.
- On prod only the variables wired in `docker-compose.yml` and the deploy workflow's two lists reach the container; `AI_MODEL` and `AI_CLIENT` are not among them (code defaults), `AI_SECOND_CLIENT` / `AI_SECOND_MODEL` are. `init_env.sh` copies every `AI_*` into `/app/.env` for cron.
- The OpenAI key on prod is the `adskip-prod` project's restricted key, created for Chat Completions only (archived change `2026-11-04-ai-second-detector-openai`, Migration Plan step 3); the Batch API also needs the Files and Batches permissions.

## Goals / Non-Goals

**Goals:**
- Either pair (Sonnet batch → luna, terra batch → Haiku) is a matter of repository variables and a deploy; clearing them is the rollback.
- The deploy that changes the pair, in either direction, loses no batch in flight and raises no false heartbeat failure.
- Nothing downstream of the model call changes: gate, publish, second-opinion agreement, review items, judge, serving.

**Non-Goals:**
- Two pairs at once, a router between them, a per-vendor budget.
- A generic provider abstraction beyond "Claude model ids start with `claude-`".

## Decisions

1. **`detector.OpenAIBatch` in the eval, synced.** Same request as `OpenAI.Detect` (one shared params builder, so the two cannot drift): a JSONL file of `{custom_id: Key, method: POST, url: /v1/chat/completions, body}` uploaded with purpose `batch`, a batch with `completion_window` `24h`; `Poll` retrieves the batch once and treats `completed`, `expired`, `failed` and `cancelled` as ended, then loads the output file and the error file into the results map (a request missing from both is an error); `Detect(Request{Key})` maps a loaded body with the existing `resultFromCompletion`. A batch `failed` as a whole (validation, the organization's enqueued-token limit) has neither file and processed nothing: its requests' errors wrap `detector.ErrBatchFailed`. It satisfies the product's `batchClient` unchanged. *Alternative*: the Responses API batch endpoint. Rejected: the synchronous transport, the eval's luna and terra runs and the strict-schema handling are all Chat Completions.
2. **`AI_DETECT_CLIENT`, empty → `AI_CLIENT` → `anthropic`.** *Alternatives*: (a) `AI_CLIENT=openai-batch` as the backlog item first wrote it: the judge and the audit would exit 1 every tick (they accept only Anthropic values); (b) the judge and the audit treating any non-fixture value as Anthropic: `AI_CLIENT=openai-batch` would then silently mean Claude for two of the three commands; (c) the vendor derived from `AI_MODEL` with `AI_CLIENT` meaning batch / sync / fixture: `AI_CLIENT=anthropic` for an OpenAI model reads wrong in every doc and log. The fallback to `AI_CLIENT`, rather than a plain `anthropic` default, keeps a test environment that sets only `AI_CLIENT=fixture` (the e2e, local runs) from ever reaching a paid API.
3. **Transport and model checks in `newDetectRun`, after the switch check.** Not in `ConfigFromEnv`, which `ai regate` also calls: regate and a switched-off tick never read the detector's transport (as `platform.FromEnv()` today). One rule for both sides: a model id starting with `claude-` is Anthropic, anything else OpenAI; `fixture` takes any id. The existing `AI_SECOND_CLIENT` value check stays in `ConfigFromEnv` and gains `anthropic`.
4. **Batch routing by the run's model.** `poll()` also selects `run.model`; the waiting batches are grouped by batch id as today and each group is polled and read through the batch client of its model's vendor, built on first use (`fixture` config: the fixture client for every batch); `finish()` takes the price of that run's model times the batch factor. *Alternatives*: (a) the batch id's prefix (`msgbatch_` vs `batch_`): vendor id formats are no contract, the model is our own recorded data; (b) a drain procedure (budget 0, wait for no `detecting` batch, then swap): two deploys each way, and a rollback would wait up to 24 h on an OpenAI batch. A request whose error wraps `detector.ErrBatchFailed` is handled as a rejected submit (`unsent`: run row dropped, queued again in an hour, no attempt spent, counted as a failed video of the tick): OpenAI reports a rejection such as the enqueued-token limit only when the batch is polled, not at create. Building the other vendor's client needs its key; both keys stay set on prod (the judge needs Anthropic, the old second opinion OpenAI), and a missing one fails that batch's poll as a poll error does today.
5. **Second opinion on Claude: the synced `detector.NewAnthropic`**, synchronous Messages, same prompt, rendering and schema, called where `confirm()` calls the second client today, outside the queue row's lock. The synced client sends no `effort` to a model whose id contains `haiku` (written for Haiku 4.5, which rejects it); Haiku 5.5 accepts effort and defaults to `medium`, the level the detector uses, so the guard costs nothing and the eval's copy stays untouched. Price row `claude-haiku-5-5`: $0.10 / $0.50, cache read $0.01, write $0.125; the long-prompt tier above 100K tokens ($0.50 / $2.50) is not modelled, as luna's 272K tier is not (prod transcripts are ~32K).
6. **Effort stays one constant (`medium`).** terra was chosen at `medium` (owner, 2026-11-04); Haiku runs at its default `medium` (decision 5). A per-side variable waits for an eval number that needs it.
7. **Wiring.** `AI_MODEL=${AI_MODEL:-}` and `AI_DETECT_CLIENT=${AI_DETECT_CLIENT:-}` in `docker-compose.yml` and both lists of `.github/workflows/deploy.yml`; `AI_CLIENT` stays unwired (prod keeps its default, the judge and the audit untouched). `init_env.sh` needs nothing (it copies every `AI_*`).
8. **Dashboard.** The second-opinion failure reasons panel gains `credit balance` (Anthropic's exhausted account) in the budget bucket and `overloaded` in the API-failure bucket; the "prompt and model" table already groups by the recorded model, the cost panels by kind. `AiCostDaily` stays at 20: terra batch ≈ $4.3 + Haiku ≈ $1.1 + judge + audit at 230 videos/day is below today's ≈ $13.
9. **At most 30 `D` items a day (`secondReviewDaily`, a constant in `confirm.go`).** Haiku leaves 0.73 entries per video unconfirmed against luna's 0.14 on Sonnet (Migration Plan step 1): ≈ 170 items a day at 230 videos, more than the assessors can take (owner, 2026-11-05). `record()` counts the items already in the day's sheet `ai-second-<UTC date>` and creates only the rest of 30; an entry past the cap stays hidden as `unconfirmed` with no item, which serves nothing extra. The count runs in `finish()`'s transaction; detect ticks never overlap (`flock`), so two videos cannot both read 29. *Alternatives*: (a) `optional` priority for every item: the queue still grows by ≈ 170 a day and the useful ones drown; (b) a variable: 30 is the assessors' capacity, not a deploy knob, and a constant change is one line.

Lock order and transactions do not change: the second call stays before `finish()`, `finish()` is one transaction (queue row → `video_calculateds` → review batch row), routing only chooses which client `poll()` calls before it.

## How it could serve a wrong segment

A different detector makes different wrong cuts, and every one it makes still reaches the same gates. Before any prod variable changes, the pair terra → Haiku must serve no more wrong cuts per hour than Sonnet → luna once the segments it would serve outside the reviewed gold are reviewed (Migration Plan step 1), and `adskip agree` must show Haiku vetoing wrong cuts at a rate comparable to luna's 25 / 61 at IoU 0.3; a Haiku that agrees with everything removes the second gate without anyone seeing it, so that number is a go / no-go, not a curiosity. On prod the second opinion, the judge and the assessors' `D` items keep working unchanged, the dashboard shows the pair's confirmed share from day one, and `AI_FIRST=off` or clearing the variables returns to Sonnet → luna for new videos at once. Rows published by terra stay until a verdict, a judge withdraw or an `ai regate` moves them, like any AI row.

## Risks / Trade-offs

- [The $100 runs out mid-month at 230 videos/day (≈ $130 at the eval price ×2)] → owner sets `AI_DAILY_BUDGET_VIDEOS` (≈ 180 fits; the first week's prod price per video settles it) with the switch; if it still runs out, every submit gets 429, the videos wait in the queue with no attempt spent, and the `ai_detect` heartbeat alert fires (rejected submits count as failed videos), which is the signal to lower the budget or switch back.
- [OpenAI limits the tokens enqueued in in-progress batches per organization and model: 1,350,000 for `gpt-6.1-terra` on 2026-11-05, shared by `adskip-eval` and `adskip-prod`] → a batch over it fails as a whole on its first poll and its videos are queued again in an hour (decision 4). Prod stays far below (`AI_BATCH_MAX` 5 × ~32K tokens ≈ 160K a batch, eval batches end in ~2 min); an eval run sends chunks of ≤ ~1M tokens (40 videos), which leaves room for prod's batches in flight.
- [OpenAI batches may take most of their 24 h window; `expire()` fails a video 24 h after its batch id was stored] → a batch ending in its last minutes can lose a paid answer; the eval's step 2 run records terra's batch latency, and a longer expiry is a follow-up only if it comes close.
- [Haiku 5.5 vetoes true ads luna would keep: 31 / 248 against 6 / 250 on Sonnet's segments] → those are missed ads, not wrong cuts; past the daily cap (decision 9) nobody reviews them. The `D` verdicts measure it on prod (`ai-second-model-revisit.md`); a stronger checker on a batch is `ai-second-opinion-sonnet-batch.md`.
- [The restricted OpenAI key has no Files / Batches permission] → the first submit fails with 401/403, the videos wait an hour with no attempt spent; the owner widens the key before switching (Migration Plan step 3).
- [Image rollback below this change with the new variables still set] → the old image would send terra to the Anthropic batch (every submit rejected) and refuse `AI_SECOND_CLIENT=anthropic` (detect and regate exit 1). Rollback order is fixed in the Migration Plan.

## Migration Plan

1. Eval (`~/Web/native-ad-skip-eval`, own commits): transport, price row, terra held-out run, sheet, review, `score` / `paired`, `adskip agree` terra → Haiku. The numbers and the eval sha go here before group 2 starts. Eval `b18f916` (`ai/SOURCE`; the detector packages are those of `bb45f01`).

   `adskip agree` on the held-out set (216–217 videos, reviewed gold, gold IoU 0.3, agreement IoU 0.3); served = confirmed entries a viewer would see:

   | pair | proposed | unconfirmed (per video) | true ads vetoed | wrong cuts vetoed | served true / wrong |
   |---|---|---|---|---|---|
   | Sonnet → luna (prod today) | 311 | 31 (0.14) | 6 / 250 | 25 / 61 | 244 / 36 |
   | Sonnet → Haiku | 309 | 53 (0.25) | 31 / 248 | 22 / 61 | 217 / 39 |
   | terra → luna | 451 | 66 (0.30) | 21 / 324 | 45 / 127 | 303 / 82 |
   | terra → Haiku | 447 | 158 (0.73) | 71 / 321 | 87 / 126 | 250 / 39 |
   | terra → Sonnet | 451 | 121 (0.56) | 31 / 324 | 90 / 127 | 293 / 37 |

   At agreement IoU 0.5 / 0.7, terra → Haiku: 101 / 137 true ads and 93 / 98 wrong cuts vetoed; Sonnet → luna: 24 / 50 and 29 / 34. terra makes twice the wrong cuts Sonnet does, luna lets most of them through, Haiku stops two thirds of them at the price of 22 % of the true ads; the pair serves what Sonnet → luna serves. The reviewed gold was built from Sonnet's stretches and favours it.

   terra alone (`2026-11-04-gpt-6.1-terra-v2.2-openai-batch-nt`, 217 videos, $2.02 = $0.0093 a video, ~376 output tokens, batches of 40 ended in 1.5–3.5 min): SCORE −0.07, 67 % ad time removed, 2218 s wrongly cut on reviewed gold; 103 of its stretches (any confidence) are outside the reviewed gold. Gate (owner, 2026-11-05, replacing the solo gate for a detector that never serves alone): the 15 segments (508 s) terra → Haiku serves that the reviewed gold does not cover (`adskip sheet -confirmed-by`; Sonnet → luna serves none), reviewed by the assessors (sheet `served-pairs-2026-11-05`, priority `optional`); terra → Haiku's served set then has no more wrong cuts per hour than Sonnet → luna's.
2. `scripts/sync-detector.sh ~/Web/native-ad-skip-eval`; product work per tasks.md; local tests; push = deploy with no variable changed: defaults are Sonnet batch → luna, nothing changes on prod.
3. Owner: widen the `adskip-prod` key to Files + Batches (or a new restricted key with Chat Completions, Files and Batches; the `OPENAI_API_KEY` secret); repository variables `AI_MODEL=gpt-6.1-terra`, `AI_DETECT_CLIENT=openai-batch`, `AI_SECOND_CLIENT=anthropic`, `AI_SECOND_MODEL=claude-haiku-5-5`, `AI_DAILY_BUDGET_VIDEOS` against the $100; Run workflow with `image_tag` = the running sha.
4. Day after and for two weeks: the dashboard's model table (new runs on terra), the second-opinion row (Haiku's confirmed share, failures), `ai_cost_usd_24h` by kind, the OpenAI project's usage page, the `D` verdicts (`ai-second-model-revisit.md`).
5. Rollback: clear the four variables and deploy the same sha (this image keeps polling the OpenAI batches in flight). Rolling the image back below this change only after that, and once `SELECT count(*) FROM prv_ai_videos v JOIN LATERAL (SELECT model FROM prv_ai_runs WHERE native_id = v.native_id ORDER BY id DESC LIMIT 1) r ON TRUE WHERE v.status = 'detecting' AND v.batch_id IS NOT NULL AND r.model NOT LIKE 'claude-%'` is 0. No schema or data change to undo.

## Open Questions

- None. Haiku 5.5's effort stays `medium` (decision 6): no eval run at another level, and the two-week `D` verdicts (`ai-second-model-revisit.md`) say first whether its veto is worth tuning.
