# Design

## Context

See proposal.md for motivation. Today `applyVerdict` (`prv/repository/ai.js:83`) refuses a keep whose new bounds overlap any other `data` entry (`others.data.some(...)`, `bounds_overlap`). Review items find their entry by effective bounds; the judge creates items with its own SQL (`ai/judge/review.go`: `addReviewItems`, `reviewBatch`) under the AI row's `FOR UPDATE`, then the batch row's. The decide route locks the batch row first, then the AI row; the judge's rule "never a batch someone holds or has a verdict in" keeps the two orders from forming a cycle. The admin page already has a state-changing GET from a confirm button (`/admin/video/:video_id/ai/withdraw`), with the auth rule that an unset token refuses every request.

## Goals / Non-Goals

**Goals:**
- A merge is a normal verdict with a trail: one verdict row, one entry, the judge's baseline moves with it.
- The operator can get an item on any entry without touching the DB and without needing another reviewer.
- No new lock order; no schema change.

**Non-Goals:**
- Changing the judge's Go SQL or its item placement.
- Dedicated UI for merging (the bounds inputs on the review page are the UI).

## Decisions

1. **Absorb lives in `applyVerdict`, not in the route.** The overlap check already sits there under the AI row lock, and the adopt script and the decide route both reach it. The rule: of `others.data` overlapping `to`, every one must be fully inside `to` and have `category_id === category.id`; then they are dropped from `data`, else `bounds_overlap` as today. The function returns the number dropped alongside the change flag (`{ changed, absorbed }` or a second return; the decide route puts `absorbed` in its JSON). Alternative rejected: a separate "merge" endpoint, which would duplicate the bounds validation, the lock order and the restore / withdraw logic.
2. **Hidden entries are not absorbed.** Served entries never overlap by invariant, hidden ones may overlap served ones (regate keeps them), so covering a hidden entry carries no information; leaving them keeps a `not_ad` trail intact. Only the existing exact-bounds rule applies.
3. **Page warning from the item payload.** The item JSON of an ai item with an AI row gets `ai_entries`: the row's served entries as `{category, start, end}` minus the item's own (by effective bounds). The page computes "covers N" client-side with the same predicate (full cover, same category as the chosen keep button) on every bounds / verdict change and in the save flash. Alternative rejected: a dry-run endpoint, more surface for the same data.
4. **Send-to-review orchestration in `prv/repository/ai.js` (`sendToReview`)**, given the review repository's primitives: under one transaction it locks the AI row (`lockAiCalculated`), finds the entry in `data` or `hidden` by exact bounds (404 when none), checks for an open ai item at those bounds (409 with its batch / code), picks the batch with the judge's rule (`reviewRepository.openPart(sheet, n)`, the JS twin of `reviewBatch`: same `FOR UPDATE OF b` query, same part names, `createBatch(…, { priority: 'urgent', reviews_needed: 1 })`), computes `position` = max position in the sheet + 1, code `M<position>`, and inserts through `reviewRepository.insertItems` with `kind: 'ai'`, `video_id`, `cues` from the run's transcript over the bounds, `link` at start − 2 s, `flagged_by = ['admin: sent to review', 'entry: <category> <confidence>, <len> s, served|hidden: <reason>']`. The lock order is the judge's (AI row → batch row), which is safe for the same reason the judge's is. Alternative rejected: reusing the judge's Go code via a CLI call from Node, slow and a new process boundary for one INSERT.
5. **Helpers move to `lib/`.** `linkAt` and `cuesOver` of `scripts/import-below-threshold.js` become `lib/player-link.js` and a `cuesOver` export of `lib/review-sheet.js` (the script requires them); the route and the script then produce identical items. Codes `M<n>` ("manual"), distinct from the judge's `A`, below-threshold `B`, served `S`, so an export says where an item came from.
6. **Route shape**: `GET /admin/video/:video_id/ai/review?verifyBearerToken=…&start=<int>&end=<int>`, mirrored on `withdraw` (same auth block, 400 on a non-numeric id or bounds). Response `201 'Sent to review: <batch> <code>'`, `409 'Already in review: <batch> <code>'`, `404 'No AI entry at these bounds'`. The page `alert`s the text and reloads. `server.js` `normalizePath` gets the rule `/admin/video/#video_id/ai/review`.
7. **Open items in the AI block**: one query per page render, ai items of the row with no verdict, keyed by bounds; a matching entry row shows `<batch> <code>` instead of the button. This is also the UI for the 409 rule.
8. **Absorbed items**: no write. Their effective bounds point at nothing, which today already means "a later verdict changes no entry". The judge's `entryKeeps` and `allKept` match by bounds, so a restore of a withdrawn row needs a keep on the merged item only (one entry). Documented in CLAUDE.md so nobody "fixes" the dangling items.

## Risks / Trade-offs

- [Votes on absorbed entries are lost] → accepted by `docs/backlog/votes-lost-when-segment-boundaries-shift.md`; the page warning says so; 0 votes on AI entries at the time of writing.
- [A reviewer absorbs a neighbour by accident while fixing a boundary] → the warning before the save; a `not_ad` on the merged item hides the whole merged stretch, and the operator can send the pieces back to review with the new link; the detector's pieces are still in `prv_ai_runs.raw_output` for `regate --backfill`, which does not restore them because they overlap a served entry (known, acceptable: the merge was a human decision).
- [Two operators click send at once] → the second waits on the AI row lock and gets the 409.
- [Judge and admin parts in the same day's sheet] → separate sheets (`ai-judge-*`, `ai-admin-*`), no shared counter.
- [Token in the URL] → `docs/backlog/admin-token-in-url.md` applies as to every admin link; no new exposure beyond the existing withdraw link.

## Migration Plan

No schema change; a plain deploy. Rollback = the previous image: items created by the link are ordinary ai items, merged entries are ordinary `source: review` entries, both readable by the old code.
