# Proposal

## Why

The first prod tick of `ai audit` (2026-11-01, 13 batches) put 33 owner / backlog findings in the owner's block, mostly the model's doubts about single verdicts. The owner wants only strict signals that something is going wrong; single doubts should be collected and reach the owner only once the same kind of problem repeats (owner, 2026-11-02). From `docs/backlog/review-audit-strict-signals.md`, explored and calibrated on the 15 prod audit rows.

## What Changes

- **Severities** of a finding become `strict` (reaches the owner), `soft` (pooled by topic) and `info` (recorded only). `owner` / `backlog` are no longer written; the block and the ping read `strict` only, so the rows of the first prod tick leave the block.
- **New strict rule findings**, fixed rules with numbers: flow checks (an ai item with no AI row, with no transcript or empty cues, an http(s)-less link, an ai item starting after the longest known duration of its video, a latest verdict that landed nowhere in the AI row, a judge / review-withdrawn row whose served entries are all kept after the withdraw and is still withdrawn, a model error on two consecutive audits of a batch), a uniform batch (≥ 10 items, ≥ 90 % `not_ad` / `unclear` by one finisher), a pace under 5 s.
- **`rubber_stamp` per reviewer**: the per-batch finding becomes `info`; one reviewer card collects them and comes back after a hide only when the reviewer's pace or keep share changes.
- **One export line per sheet** replaces the per-batch `eval_ready` owner finding (`eval_ready` stays as `info`); hide = exported, the line comes back when more parts of the sheet are finished.
- **Pattern cards**: after every audit, the soft findings of the last 30 days are counted by topic; a topic with ≥ 5 items in ≥ 3 batches becomes one card (counts, examples with links, suggested action). Hide stores what was counted; the card comes back on 5 new items in 3 new batches.
- **Model findings**: no severity; each carries a `topic` from a fixed list. The prompt (`ai/prompts/audit-v2.md`) gets the assessor rules from the review page's own strings (`prv/locales/review/ru.json`) and must not doubt a keep only because the text names no payer.
- `judge_false_alarm`, `track_mismatch` and a served item judged not an ad (the old `precision` owner case) become soft findings with their own topics. `precision`, `category_flip` and `bounds` stay `info`.
- **Dropped**: the `agreement` rule (one assessor does all the work, `reviews_needed` is 1 on every batch).
- **Telegram** (`AI_AUDIT_TELEGRAM`, still off on prod): carries new strict findings and pattern / reviewer cards that became visible; no export lines.
- Owner's page: the block shows strict signals per audit, export lines and cards; a card has its own hide (`POST /admin/review/cards/:id/hide`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `review-batch-audit`: rule findings (new strict rules, `agreement` dropped, severities `strict` / `soft` / `info`), model findings (topic instead of severity, the page's rules in the prompt), the record's severity values, the owner block (strict signals, export lines, cards with their own hide), the ping (strict findings and cards); new requirements for the topic pool, the reviewer card and the export line.

## Impact

- Go: `ai/audit/` (`rules.go`, `due.go` reads the AI rows, runs and video durations of the batch, `llm.go` schema and rules text, new `cards.go` for the pool, reviewer and export cards, `notify.go`, `audit.go`, `config.go` `AI_AUDIT_RULES`); `ai/prompts/audit-v2.md` replaces `audit-v1.md`.
- Node: `prv/db/index.js` (`ReviewAuditCard`, table `prv_review_audit_cards`, by `sync()`), `prv/repository/review.js` (`ownerAudits` on `strict`, `ownerCards`, `hideCard`), `prv/routes/admin-review.js` (block, card hide route), `prv/locales/review/{ru,en}.json`, `server.js` `normalizePath`.
- Tests: `ai/audit/*_test.go`, `test/e2e.js` audit tests and `test/fixtures/ai/*.audit.json` on the new schema.
- Docs: CLAUDE.md (Ops → Audit, Routes → `admin-review.js`, Database Models, Environment Variables).
- No serving, verdict, judge or detector change; no new switch.
- After the deploy the owner re-audits the 13 batches of the first tick by hand (`ai audit <batch>`, about $0.40), so their findings get topics and feed the pool.

## Out of scope

- Acting on findings ("Do it" buttons, automatic blind subsets): `docs/backlog/review-audit-actions.md`.
- Whether the paid model call is worth it: `docs/backlog/review-audit-value-and-cost.md`.
- Rewriting the assessor rules ("the video decides"): `docs/backlog/assessor-rule-text-vs-video.md`; the audit prompt only stops doubting such keeps.
- Telegram reachability from the prod host: `docs/backlog/telegram-blocked-from-prod-host.md`.
- A separate digest command, a model call that merges `other` topic names, cross-assessor checks (dropped by the owner, 2026-11-02).
