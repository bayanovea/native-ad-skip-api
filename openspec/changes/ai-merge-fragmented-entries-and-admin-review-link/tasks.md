# Tasks

## 1. Shared helpers

- [x] 1.1 Move `linkAt` to `lib/player-link.js` and `cuesOver` to `lib/review-sheet.js`; `scripts/import-below-threshold.js` requires them. Proof: `make test-unit` (`test/review-sheet.test.js` gets a `cuesOver` case) and the two `import-below-threshold` e2e tests unchanged.

## 2. Absorb on keep

- [x] 2.1 `prv/repository/ai.js` `applyVerdict`: covered same-category `data` entries are dropped instead of `bounds_overlap`; partial overlap or another category still throws; return the absorbed count next to the change flag; update the doc comment. Proof: new e2e `ai review merge: a keep whose bounds cover same-category served entries absorbs them (one entry, source review, rating from the new bounds, hidden untouched); a partial overlap and another category stay 400 bounds_overlap; an absorbed entry's item is history` in `test/e2e.js`, seeded with four entries as the owner's video.
- [x] 2.2 `prv/routes/admin-review.js` decide: `absorbed` in the 201 JSON; item payload of an ai item with an AI row carries `ai_entries` (served entries minus its own). Proof: the e2e of 2.1 asserts `absorbed: 2`, and the existing `ai review bounds: the item page carries the transcript window…` test asserts `ai_entries`.
- [x] 2.3 Review page script + `prv/locales/review/{ru,en}.json`: `warn_bounds_absorb` under the inputs and in the save flash when the bounds cover N other served entries of the chosen keep category; hidden when none. Proof: `test/i18n.test.js` parity; the e2e of 2.2 checks the key is in `STATE.i18n` and `ai_entries` in the page JSON; manual check on the local dump.

## 3. Send to review from /admin/video

- [x] 3.1 `prv/repository/review.js`: `openPart(sheet, n, { transaction })` (the judge's `reviewBatch` in JS, same query and part names) and `openItemAt({ video_id, start, end }, { transaction })` (ai item without a verdict at the bounds). Proof: covered by the e2e of 3.3 (held part → `-p2`; open judge item → 409).
- [x] 3.2 `prv/repository/ai.js` `sendToReview(videoId, { start, end }, reviewRepository)`: AI row lock, entry lookup in `data` / `hidden`, 409 / 404 outcomes, item via `insertItems` with code `M<n>`, cues, link, `flagged_by`, batch via `openPart` + `createBatch` urgent. Proof: the e2e of 3.3.
- [x] 3.3 `prv/routes/admin.js`: `GET /admin/video/:video_id/ai/review` (auth and 400 as withdraw; 201 / 404 / 409 texts), per-entry button with confirm in the AI block, open-item marker `<batch> <code>` per entry; `server.js` `normalizePath` rule. Proof: new e2e `ai-first: the admin send-to-review link creates an urgent ai item on a served or hidden entry (M codes, today's ai-admin batch, held part → -p2), refuses an open item with 409, wrong token 401, no entry 404; the block shows open items`, plus `test/prometheus-wrapper.test.js` or the existing normalizePath test for the new path.
- [x] 3.4 End-to-end of the owner's case in e2e: send → take `ai-admin-<today>` as a second reviewer → keep with covering bounds → `GET /video-calculated` serves two sponsor entries, the merged one `source: review`. Proof: the test passes under `make test-e2e`.

## 4. Docs

- [x] 4.1 CLAUDE.md: Votes / Verdicts paragraph (absorb rule, absorbed items are history), `admin.js` route list (the review link), ReviewItem row (`M<n>`, `ai-admin-<date>`, the JS twin of `reviewBatch`), `lib/` table (moved helpers), Prometheus `normalizePath` example. Proof: the text matches the e2e assertions of 2.1 and 3.3.
- [x] 4.2 `docs/ai-first-overview/{ru,en}.html`: the assessor section says a keep with wider bounds merges same-category neighbours, and the "updated" date; republish both artifacts from the repo files. Proof: both artifact URLs show the new date.
- [x] 4.3 Backlog: delete `docs/backlog/ai-merge-fragmented-entries-and-admin-review-link.md`; in `ai-owner-verdict-merge-video-100000005.md` replace "Blocked by" with the live steps (route name, codes). Proof: `git status` shows the two files.
- [x] 4.4 Cleanup pass before commit (residue, transient state, open questions); `go vet ./...` untouched (no Go change), `make test-unit`, `make test-e2e` green.

## Workflow follow-up

- Push only on the owner's word (push = prod deploy); then the owner's merge on video 104583 per its backlog item.
- Archive the change after the deploy check.
