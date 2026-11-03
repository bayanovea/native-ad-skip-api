# Design

## Context

See proposal.md, Why. What exists (archived `review-batch-audit`, `e0272b0`):

- `ai audit` reads one batch in a `REPEATABLE READ READ ONLY` transaction (`readBatch`, `ai/audit/due.go`: items, verdicts, finishers, latest `track_mismatch`), runs eight rules (`ai/audit/rules.go`), makes one Messages call (`ai/audit/llm.go`, prompt `ai/prompts/audit-v1.md`), inserts a `prv_review_audits` row with `new` per finding against the batch's previous row, and pings findings with severity `owner` / `backlog`.
- The owner block (`reviewRepository.ownerAudits()`, `renderAudits` in `prv/routes/admin-review.js`) shows each batch's latest unhidden audit with a new `owner` / `backlog` finding. Hide is per audit.
- Calibration on the 15 prod audit rows (owner, 2026-11-02, `~/audit-calib.sh`): every flow check reads 0; the uniform-batch and pace-under-5-s checks never fire (max 11 / 28 `not_ad`, min median gap 12.7 s); one absorbed keep exists; 31 of 659 sheet items start after the cut; one assessor does all the work; Gam's median gap is 12–14 s on most batches.

## Goals / Non-Goals

**Goals:**
- What reaches the owner is computed by rules, or is a count of repeated model doubts. A single model opinion never reaches the owner.
- Each card comes back only on evidence it has not shown yet, so a hide is not undone by the next tick.

**Non-Goals:**
- A configurable rules engine: thresholds stay Go constants.
- Per-finding state on strict findings: hide stays per audit.
- Merging `other` names with a model call (owner, 2026-11-02: dropped).

## Decisions

**Severities `strict` / `soft` / `info` replace `owner` / `backlog` / `info`.** The block and the ping filter on `strict`; the pool reads `soft` with a `topic`. Rows written before the change keep their `owner` / `backlog` values. They match neither filter, so they leave the block at the deploy, and the 13 batches are re-audited by hand (owner: old audits count, but their findings have no topic and were made without the page rules). Alternative rejected: map `owner` → strict when reading old rows. That would bring back the 33 findings the owner asked to remove.

**Flow checks in the batch read.** `readBatch` also reads, in the same snapshot: the AI rows of the batch's ai items' `video_id`s (`data`, `hidden`, `withdrawn_at`, `withdrawn_by`, `run_id`), `jsonb_array_length(transcript->'cues')` of their runs, the longest `videos.duration` per native_id of the batch, the `markup_categories` names, the items' `link`, and for each such AI row every ai item on it from any batch, with its latest verdict, decision time and effective bounds (latest verdict with bounds, else its own). That is what `withdrawn_all_kept` needs, since a row's other entries can sit in other batches. Still no row lock. The checks mirror `applyVerdict`:
- `verdict_not_applied` (keep): an entry of the verdict's category at the effective bounds in `data` or `hidden` (a short keep lands in `hidden`), or a served entry of that category with `start ≤ s` and `end ≥ e` (absorb). `not_ad` / `unclear`: a `hidden` entry with reason `review` at the effective bounds. A `not_ad` on an item whose entry was absorbed into another item's keep fires this check. That is right: the assessor said "not an ad" and viewers still get it inside the wider entry.
- `withdrawn_all_kept`: `withdrawn_by` ∈ `judge`, `review`, non-empty `data`, every `data` entry with an ai item whose latest verdict is a keep decided after `withdrawn_at`. This is `allKept` in `prv/repository/ai.js`, restated in Go as `judge.EntryKeepsAll` already restates it.
- `ai_item_beyond_duration`: ai items only. Sheet items past the cut are a known property of the eval corpus, and the page already warns.
- `link_not_http`: every item.

**Strict thresholds** (Go constants): `uniformMinItems = 10`, `uniformShare = 0.9`, `fastPaceGap = 5 s`, both per finisher other than `OwnerReviewer`. `llm_error_repeat` compares with the previous row's `llm_error`, which `previous()` already reads, so it adds no query.

**Model findings carry a topic.** Schema `{summary, findings: [{kind: comment|other, topic, name, items, text, action: {type, note}}]}`, `topic` ∈ `dubbing_credits`, `platform_promo`, `raffle_partner`, `boundary`, `sponsor_vs_self_promotion`, `timing`, `subtitle_drift`, `page_link`, `judge_recut`, `other` (the 20 prod findings sorted by hand, owner 2026-11-02). `name` is required and non-empty for `other` (cut to 40 characters, lowercased and trimmed for grouping), and empty otherwise. Severity is set by Go (`soft`). A finding with an unknown topic is dropped like one with an unknown code.

**The page's rules in the prompt, from the strings.** `AI_AUDIT_RULES` (default `/app/prv/locales/review/ru.json`, a path like `AI_PROMPT`, so not wired in compose) is read at start. Keys in a fixed list (`rules_who_paid_html`, `rules_call_to_action_html`, `rules_not_ad_html`, `rules_track_html`, `rules_bounds_html`, `onb_verdicts_html`, `onb_track_html`, `onb_bounds_html`) are taken with tags stripped and entities decoded, and appended to the system prompt under a heading. A missing key is a startup error. `prompt_sha` is the sha of the full system text, so a rules change shows in the row. The new prompt `ai/prompts/audit-v2.md` (default `AI_AUDIT_PROMPT`) states: the page's rules decide, a keep is never doubted only because the text names no payer (owner, 2026-11-02: the video decides, `assessor-rule-text-vs-video.md`), a `not_ad` / `unclear` is never doubted only because neighbouring items of the video were kept (owner, 2026-11-03: D17 of `ai-second-2026-11-02`, rightly `not_ad` between three kept pieces of one integration), and the model reports doubts only and sorts each one into a topic. `audit-v1.md` is deleted, since an older image carries its own copy. Alternative rejected: paraphrase the rules in the prompt. 2 of the 4 recurring prod "patterns" were doubts the page's rules already answer.

**Cards in one table, written by Go.** `prv_review_audit_cards` (`ReviewAuditCard`, by `sync()`): `id`, `kind` (`pattern` | `reviewer` | `export`), `key` (topic, `other:<name>`, reviewer code or sheet), unique `(kind, key)`, `counts` JSONB, `examples` JSONB (`[{batch, item, text}]`), `action` JSONB, `visible` BOOL, `shown_at`, `notified_at`, `hidden_at`, `hidden_by`, `hidden_counts` JSONB, `updated_at`. After each audit row (tick and manual run), `recountCards` runs in one transaction. Three queries (topics, reviewers, sheets) feed pure Go functions that decide visibility against `hidden_counts`, and each card is upserted. A card that turns visible gets `shown_at = NOW()`, `notified_at = NULL`, `hidden_at = NULL`. Node only reads visible cards and hides them. Hiding copies the current counts (with the counted item and batch keys) into `hidden_counts` and sets `visible = false`. Alternative rejected: compute cards in Node at page load. The ping lives in Go and must know when a card turns visible. Two copies of the pool SQL would drift.
- **Pattern**: latest audit per batch with `created_at > NOW() − 30 days`, `jsonb_array_elements(findings)` with `severity = 'soft'`, grouped by topic (`other:` + name). Counted as distinct `batch/item` keys and distinct batches. Visible at ≥ 5 items in ≥ 3 batches (`patternItems`, `patternBatches`). When hidden, the same test runs on keys not in `hidden_counts`. Examples: the 5 newest items with their finding text. Action: the most frequent `action.type` among the topic's findings, ties to the newest, with that finding's note. Rule topics (`judge_false_alarm`, `track_mismatch`, `served_not_ad`) suggest a fixed type (`backlog_item`, `none`, `none`).
- **Reviewer**: reviewers with a `rubber_stamp` finding in those latest audits. Counts: batches, median of the findings' `median_gap_s`, and keep share over the reviewer's latest verdict per item decided in the last 30 days. Visible when not hidden. When hidden, it comes back if the median moved ≥ 25 % (`reviewerPaceChange`) or the keep share ≥ 0.10 (`reviewerKeepChange`) from `hidden_counts`. The owner's words were "back only when their pace or keep share changes"; the 25 % absorbs Gam's daily 12–14 s spread.
- **Export**: sheets named by an `eval_ready` finding in any audit row (no 30-day bound, so a long sheet keeps its line). Counts: parts and finished parts (`finishedOf` per part, all reviewers). Visible when not hidden. When hidden, it comes back when the finished parts exceed `hidden_counts.finished`. Never pinged.

**Block and routes.** `ownerAudits()` filters `severity = 'strict'`. `ownerCards()` returns visible cards, export lines first, then patterns and reviewers by `shown_at DESC`. `/admin/review` with `reviewer=bayanovea` renders strict audits, export lines and cards in one card (`renderAudits` grows two lists). Example links go to `/admin/review/<batch>?item=<code>&reviewer=bayanovea&verifyBearerToken=…`, the same link shape as the block's batch link. JSON: `audits` and `cards`. `POST /admin/review/cards/:id/hide?verifyBearerToken=…`, body `{reviewer}`, has the audit hide's rules (403 unless the owner, 404 for an unknown id, form → 303, JSON → 200 `{id, hidden: true}`; a second hide keeps the first) and does `UPDATE … SET visible = false, hidden_at = COALESCE(hidden_at, NOW()), hidden_by = COALESCE(hidden_by, :reviewer), hidden_counts = counts`. A hide racing a recount is safe: the recount's upsert keeps `hidden_*` and re-derives `visible` from them. `normalizePath`: `/admin/review/cards/#id/hide`. Strings `audit_*` keys in both locales, severity labels `strict` / `soft` / `info`, card titles.

**Telegram.** `unsent()` and `pings()` switch to `strict`. Cards: each tick (and manual run), after the recount, sends every `pattern` / `reviewer` card with `visible`, `notified_at IS NULL`, `shown_at` in the last 7 days, one message each (topic or reviewer, counts, example codes, no host or token), then sets `notified_at`. Off: nothing is sent and nothing marked.

**Transactions and locks.** `readBatch` stays one read-only snapshot. The audit row insert stays its own statement. `recountCards` is one read-write transaction on `prv_review_audit_cards` only; the `flock` serialises ticks and manual runs, and the hide route touches one row. No `video_calculateds`, AI row or batch row is locked or written.

## How it could serve a wrong segment

It cannot. The audit still writes only its own tables and messages; serving, `applyVerdict`, `ai regate` and the judge never read `prv_review_audits` or `prv_review_audit_cards`. The new AI-row reads are inside the read-only snapshot. The e2e test's "AI rows unchanged after the audit" check stays.

## Risks / Trade-offs

- [A flow check fires on a legitimate state the mirror of `applyVerdict` misses] → a strict finding the owner sees once, per audit. Each check has a Go table test per case of `applyVerdict` (served, hidden short, absorbed, review-hidden). `verdict_not_applied` on an absorbed item with a later `not_ad` is intended.
- [Topics sorted inconsistently by the model] → the pool needs 5 items in 3 batches, so a few mis-sorted findings never make a card. `other` names rarely match exactly, so `other` rarely makes one (accepted: the merge call was dropped).
- [The rules text grows the prompt] → about 2–3 k more input tokens per call, under a cent per batch.
- [A locale key renamed on the page] → the audit fails at start naming the key, and `CalculatorFailedVideos` / stale fire. `test/i18n.test.js` gains a check that every key in the Go list exists.
- [The reviewer card's tolerance is a guess] → constants with the reason next to them; the owner adjusts them after a few weeks.

## Migration Plan

1. Deploy (switches unchanged, `AI_AUDIT_ENABLED=on`, `AI_AUDIT_TELEGRAM` off). `sync()` creates `prv_review_audit_cards`. The block empties of the first tick's findings, since they are `owner` / `backlog`.
2. Owner re-audits the 13 batches inside the app container, under the audit lock: `flock /tmp/ai-audit.lock /app/prv/commands/ai/ai audit <batch>` each (about $0.40). The rows feed the pool; the block shows the strict signals, export lines and any cards.

Rollback: the previous image never reads `prv_review_audit_cards` (it stays; a roll-forward recounts it). Its `ownerAudits` filters `owner` / `backlog`, and it reads each batch's latest row, so a re-audited batch is off its block and a batch not yet re-audited shows its first-tick audit again. Its tick writes v1 rows (its own `audit-v1.md`), which the pool of a later roll-forward ignores (no topic). No schema in use by the old image changes.
