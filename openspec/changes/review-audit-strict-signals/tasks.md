# Tasks

## 1. Severities and strict rule findings (Go)

- [ ] 1.1 `ai/audit/rules.go`: severities `strict` / `soft` / `info` (`pings()` on `strict`), `Topic` on `Finding`; `rubber_stamp`, `eval_ready`, `precision`, `category_flip`, `bounds` as `info`; `judge_false_alarm`, `track_mismatch` and the served-not-ad case (new kind `served_not_ad`, out of `precision`) as `soft` with their topic; `agreement` and `agreementOwnerBelow` removed. Verify: `rules_test.go` updated per spec "Rule findings" scenario, plus "two finishers disagree → no finding".
- [ ] 1.2 `ai/audit/due.go`: `readBatch` also reads, in the same snapshot, the items' `link`, the AI rows of the batch's `video_id`s, their runs' cue counts, the longest `videos.duration` per native_id, `markup_categories`, and every ai item on those AI rows (any batch) with its latest verdict, decision time and effective bounds (design "Flow checks"). Verify: `go test -mod=vendor ./ai/audit` with sqlmock expectations for the new queries; e2e 5.1 reads a real batch.
- [ ] 1.3 `ai/audit/rules.go`: strict rules `ai_item_no_row`, `ai_item_no_transcript`, `link_not_http`, `ai_item_beyond_duration`, `verdict_not_applied`, `withdrawn_all_kept`, `uniform_batch`, `fast_pace` (constants `uniformMinItems`, `uniformShare`, `fastPaceGap`), and `llm_error_repeat` in `audit.go` against `previous()`'s row (it returns the `llm_error` too). Verify: `rules_test.go` table cases: served keep, hidden-short keep, absorbed keep (no finding), keep with no entry, `not_ad` with / without a review-hidden entry, absorbed item then `not_ad` (finding), judge- and admin-withdrawn rows, sheet item past the cut (no finding), 9 vs 10 items, median 4.9 vs 5 s; `audit_test.go` two consecutive `llm_error` rows → `llm_error_repeat`.

## 2. Model findings with topics and the page's rules (Go, prompt)

- [ ] 2.1 `ai/audit/config.go`: `AI_AUDIT_RULES` (default `/app/prv/locales/review/ru.json`), `AI_AUDIT_PROMPT` default `/app/ai/prompts/audit-v2.md`. Verify: `config_test.go` defaults.
- [ ] 2.2 `ai/audit/llm.go`: rules text from the fixed key list (tags stripped, entities decoded, missing key = startup error) appended to the system prompt, prompt sha over the full text; schema with `topic` (fixed enum) and `name`, no `severity`; `parseOutput` drops unknown topics and `other` without a name, sets `soft`, cuts `name` to 40. Verify: `llm_test.go` (rules text in the request, sha changes with a rules string, unknown topic dropped, `other` without name dropped, valid answer → soft findings with topic); `test/i18n.test.js` checks every key of the Go list (read from `ai/audit/llm.go` or a shared `ai/prompts/audit-rules-keys.txt`) exists in both locales (`make test-unit`).
- [ ] 2.3 `ai/prompts/audit-v2.md` replaces `audit-v1.md` (deleted): the page's rules decide; never doubt a keep only because the text names no payer (owner, 2026-11-02); never doubt a `not_ad` / `unclear` only because neighbouring items of the video were kept (owner, 2026-11-03); doubts only, each with a topic from the list and what each topic means. Verify: `grep -rn audit-v1 --exclude-dir=vendor --exclude-dir=openspec .` is empty; e2e fixtures 5.1 parse under the new schema.

## 3. Cards and the ping (Go)

- [ ] 3.1 `prv/db/index.js`: `ReviewAuditCard` (table `prv_review_audit_cards`, columns per design "Cards", unique `(kind, key)`), exported. Verify: `node scripts/sync-db.js` against the local dump (localhost:5433) creates it; `\d prv_review_audit_cards` matches.
- [ ] 3.2 `ai/audit/cards.go`: `recountCards` (one transaction: the topic, reviewer and sheet queries, pure visibility functions against `hidden_counts`, upsert keeping `hidden_*`, `shown_at` / `notified_at` reset on turning visible), called after every audit row in `audit.go` (tick and manual run); constants `patternItems = 5`, `patternBatches = 3`, `poolWindow = 30 days`, `reviewerPaceChange = 0.25`, `reviewerKeepChange = 0.10`. Verify: `cards_test.go` for the pure functions (4 items / 3 batches no card, 5 / 3 card, hidden + 2 new stays hidden, 5 new in 3 new batches back, re-audited batch counted once, `other` grouped by name, reviewer 13 → 12 s stays hidden, 13 → 9 s back, keep share +0.10 back, export 2/3 hidden → 3/3 back); e2e 5.2.
- [ ] 3.3 `ai/audit/notify.go` + `audit.go`: `unsent()` on `strict`; card messages (pattern / reviewer, visible, unnotified, `shown_at` in the last 7 days; topic or reviewer, counts, example codes, no host or token) after the recount, `notified_at` set; export lines never sent; switched off, nothing sent or marked. Verify: `notify_test.go` (strict only, a card message, no export message, failure leaves the card unnotified and counts failed); e2e 5.3.

## 4. Owner block and routes (Node)

- [ ] 4.1 `prv/repository/review.js`: `ownerAudits()` on `strict` (`OWNER_SEVERITIES`), `ownerCards()` (visible, export first, then by `shown_at DESC`, example items joined to their batch), `hideCard(id, reviewer)` (design "Block and routes"). Verify: e2e 5.2.
- [ ] 4.2 `prv/routes/admin-review.js`: `renderAudits` with strict audits, export lines (sheet, parts finished of total) and cards (counts, example links to `/admin/review/<batch>?item=<code>`, suggested action, hide form); `cards` in the list JSON for the owner only; `POST /admin/review/cards/:id/hide`; `prv/locales/review/{ru,en}.json` (`audit_severity_strict`, card and export strings; `audit_severity_owner` / `_backlog` removed); `server.js` `normalizePath` `/admin/review/cards/#id/hide`. Verify: `make test-unit` (`test/i18n.test.js` parity), e2e 5.2.

## 5. End-to-end tests (`test/e2e.js`, fixtures `test/fixtures/ai/*.audit.json`)

- [ ] 5.1 Update the existing audit tests and fixtures to the new schema and severities (a strict flow finding, e.g. a keep with no entry, makes the block entry; soft and info only → none); add `audit: an ai batch whose verdict landed nowhere gets verdict_not_applied, one whose keep was absorbed does not; the AI rows are unchanged`. Verify: `make test-e2e`.
- [ ] 5.2 `audit: soft findings of three audited batches with five items of one topic make one pattern card for bayanovea only (HTML and JSON); hide by another code is 403, hide by bayanovea removes it; two more items keep it hidden, five new items in three new batches bring it back; a sheet batch shows one export line that comes back when another part finishes`. Verify: `make test-e2e`.
- [ ] 5.3 `audit: with the stub Telegram server a pattern card and a strict finding are sent once each, an export line never; with AI_AUDIT_TELEGRAM off nothing is sent`. Verify: `make test-e2e`.

## 6. Docs and cleanup

- [ ] 6.1 CLAUDE.md: Ops → Audit (severities, strict rules, the pool and cards, the page's rules in the prompt, re-audit by hand), Routes → `admin-review.js` (owner block, card hide route), Database Models (`ReviewAudit` severities, `ReviewAuditCard`), Environment Variables (`AI_AUDIT_RULES`, `AI_AUDIT_PROMPT` default), Prometheus Metrics `normalizePath` list. Verify: every name in the text exists in the diff (`grep` each).
- [ ] 6.2 Cleanup pass before commit: leftover `severityOwner` / `severityBacklog` / `agreement` / `audit-v1` / `audit_severity_owner` via `grep -rn` outside `vendor/` and `openspec/changes/archive/`; no transient state in the artifacts; open questions to `docs/backlog/`; delete `docs/backlog/review-audit-strict-signals.md`. Verify: `openspec validate review-audit-strict-signals --strict`; `make test-unit`, `go test -mod=vendor ./calculator ./ai/...`, `make test-e2e` green.

## Workflow follow-up

- Commit on the owner's "commit"; push (= prod deploy) only on the owner's "push". No switch changes: `AI_AUDIT_ENABLED` stays on, `AI_AUDIT_TELEGRAM` off.
- After the deploy, the owner re-audits the 13 batches of the first tick inside the app container: `flock /tmp/ai-audit.lock /app/prv/commands/ai/ai audit <batch>` for each (about $0.40), then checks the block: the first tick's findings gone, strict signals (expected none), export lines, any pattern or reviewer card.
- Day-after check: `ai_audit` heartbeat, the day's audit rows have topics on their soft findings, `prv_review_audit_cards` counts match the block, `ai_cost_usd_24h{kind="audit"}`.
- Archive after the owner confirms the prod check; the archive is the record.
