# Design

## Context

See proposal.md for the motivation and the prod numbers. What shapes the approach:

- `prv_ai_video_calculateds.data` is exactly what `GET /video-calculated` sends for an AI-served video, `hidden` is the rest with a `reason`; both are precomputed and nothing is evaluated on the read path (owner, 2026-10-27). The vote handlers, `--recompute-ratings`, the judge, `ai regate`, the later second opinion and `applyVerdict` all read `data` as "the row's entries", and until now every entry was the model's or a reviewer's.
- The calculator rewrites a video's `prv_calculated_segments` on every recalculation (delete, insert, new ids), within a minute of a markup, under the `video_calculateds` row lock. Segments of neighbouring 3-s buckets are separate rows: one prod video has five sponsor segments for two ads.
- A review item finds its entry by bounds (`applyVerdict`, `allKept`, the judge's `entryKeeps`), served entries never overlap, and assessors answer `sponsor` / `self_promotion` / `not_ad` / `unclear`; they set bounds on 1 of 619 keeps.
- Owner decisions this design implements: build it, a live user markup is the most explicit signal the model may be wrong (owner, 2026-11-25); glue automatically when the difference is small and take the user's signal, because the model reads subtitles and users see the picture (owner, 2026-11-26); the glue limit is 20 s (owner, 2026-11-26); a standalone user segment is shown until an assessor has checked it (owner, 2026-11-26); intro and credits are included (owner, 2026-11-26); the old queue is not taken, a blind test of 30 decides (owner, 2026-11-26). The owner left one case to this design ("decide yourself", 2026-11-26): a neighbour that adds more than the limit, see decision 4.

## Goals / Non-Goals

**Goals:**
- A new user markup on an AI-served video reaches viewers within two minutes or reaches an assessor, and never disappears silently.
- `data` stays the single precomputed truth of what is served; every existing reader keeps working on it.
- One switch whose off position restores today's serving within one tick.

**Non-Goals:**
- Correcting an AI entry's edges from a user segment that mostly agrees with it, or trimming an AI entry.
- Any change to the human path, to `rt` / `yt`, to the extension or to the detector.

## Decisions

### 1. User segments become entries of the AI row, `source: "user"`

The pass writes them into `data`. `source` already tells entries apart (`ai`, `chapter`, `review`); one more value keeps serving, votes and ratings untouched (they go by bounds and category).

Alternatives: a read-time union of `video_calculateds` and the AI row (rejected by the owner's rule, and votes resolve "what GET serves" from one array); a second column `user` next to `data` (three readers would have to union it and "`data` is exactly what is served" would stop being true, while a glue changes `data` anyway).

The cost is that code which assumed "an entry is the model's claim" must skip user entries: decision 9 lists every such place.

### 2. A separate state-based pass, `ai users`, every minute

Cron `* * * * *` with `sleep 50` (the calculators use 0 / 20 / 40 s) under `flock -n /tmp/ai-users.lock`, code in `ai/pipeline/users.go`, its own config reader (`AI_USER_SEGMENTS_ENABLED`, `AI_USER_SEGMENTS_SINCE`, `AI_USER_GLUE_SECONDS`), so a bad value never stops `ai detect`.

Each tick derives the wanted state from what is in the database now, with no watermark: the calculator deletes and re-inserts segments and a deleted markup leaves no trace, so "what changed since" cannot be read. Three set queries outside any lock (candidate rows: not withdrawn, with user segments of the video, or a `source: "user"` entry, or a `glued` hidden entry; their segments with authors, ratings and the newest markup or interval edit; their items with the latest verdict and effective bounds), a pure function per row, and a locked transaction only for a row whose wanted state differs. 338 of 3,936 served rows have user segments today.

Alternatives: inside the calculator's transaction (couples the minute-critical calculator of three providers to AI rules); inside `ai judge` (hourly: the author reloads the page and still sees nothing) or `ai detect` (its tick sleeps `AI_FETCH_PAUSE` per video).

A row published a moment ago gets its user entries on the next tick, so users' segments can be missing for up to a minute after a publish.

### 3. The unit is a clustered calculated segment

Segments of one category with IoU ≥ 0.5 are one, at the bounds of the member with the most authors (best rating, newest markup, lowest id). It is deduplicated, has whole-second bounds and is what the human path would serve, so a vote on the entry rates the same authors.

### 4. Where a segment goes

The row is first read as if nothing were glued: `model` = `data` without user entries, plus the `glued` hidden entries that no served entry overlaps. With no model entry (or a withdrawn row) the wanted user set is empty. Ad segments are taken in the order of decision 3, then intro and credits; each placed entry counts as served for the next one.

| An eligible ad segment U | Outcome |
|---|---|
| closed by a verdict (decision 7) | nothing |
| `model` covers ≥ half of U | nothing: the AI's edges stay (backlog `ai-user-edge-disagreement-untested`) |
| same-category unpinned model entries N that U overlaps or lies within `AI_USER_GLUE_SECONDS` of; `len(U ∪ N) − Σ len(N) ≤ AI_USER_GLUE_SECONDS`; the union overlaps nothing else served | glue (decision 5), no item |
| U overlaps a served entry | held: `data` unchanged, item at U ∪ the same-category model entries it overlaps |
| otherwise | shown: entry at U's bounds, item at the same bounds |

"Pinned" = the entry's latest ai-item verdict is a keep (`judge.EntryKeepsAll`) or its `source` is `review`: an assessor looked at it, so nothing extends it without one.

The delegated case. A neighbour adding more than the limit is held only when it overlaps a served entry; one that merely adjoins it is shown like any standalone segment. Showing an adjoining segment changes no AI entry and carries the risk the owner already accepted for standalone segments, while an overlapping one cannot be served without replacing the AI entry (served entries never overlap), and replacing it by an unchecked stretch of any length is what the limit exists to prevent: the blind sample has a 16-minute user segment over a 20-second AI entry. At 20 s none of the sample's nine neighbours is glued: their additions are 34 to 940 s.

Intro and credits: every clustered segment with a best author rating ≥ 0, no cut-off and no length rule (owner, 2026-11-26: as they are), skipped when it overlaps anything placed before it; no item.

### 5. A glue is one entry at the union's bounds; the model's entries wait in `hidden` as `glued`

The glued entry has the category, `source: "user"` and no `confidence`. The absorbed model entries move to `hidden` unchanged but for `reason: "glued"` and no rating. Because the pass re-derives from `model` every tick, undoing a glue needs no bookkeeping: when the rule no longer holds, the bases simply are in `data` again (with the votes' rating, `calculator.WithVoteRatings`).

Alternatives: keeping the originals inside the glued entry (Go's `Entry` round-trips through `ai regate` and the backlog pass and would drop an unknown field; `hidden` is where the row already keeps what it does not serve, and an item on a base still finds its entry there); two abutting entries instead of one (the viewer gets two skips and two rows in the list, and the owner asked for one segment).

Votes on the base's bounds count nowhere while it is glued, as with any bounds change (`docs/backlog/votes-lost-when-segment-boundaries-shift.md`).

### 6. `source: "user"` means unverified and owned by the pass

A keep turns the entry into `source: "review"` even when nothing moves, and `not_ad` / `unclear` hide it as `review`; from then on the pass, like every other writer, treats it as an assessor's entry and never touches it. So the pass may add, move and remove exactly the entries with `source: "user"`, and the switch-off cleanup is "remove them all".

`applyVerdict` changes (spec delta `ai-verdict-application`): served user entries that the keep's bounds overlap are removed before the absorb / overlap checks (also before the "inside a wider served entry" exits, which would otherwise make a keep on the model's hidden entry a no-op under a shown user segment); `glued` entries inside a decided user entry follow the verdict; a keep on a `U` item without an entry creates a `review` entry; withdraw-on-empty and `allKept` count non-user entries.

### 7. Items and how a segment is matched to them

Sheet `ai-user-<UTC date>`, codes `U<n>`, priority `urgent` for both shown and held (a batch has one priority, and about 2 a day do not need two sheets), written with `review.Add` in the row's transaction. `flagged_by`: `user markup: <n> authors, best rating <r>`, then `shown` or `held: overlaps <category> <a>-<b>`.

A segment's *target* is the bounds its item would have (decision 4). Its own item is a `U` item of the row whose own bounds have IoU ≥ 0.5 with the target; IoU rather than equality, because a second user's markup shifts the segment's average start by a second. No own item: create one. Undecided: the segment's state stands (a shown entry stays at the item's bounds), no new item. Decided: closed. A segment is also closed when any item of the native id (any kind, so the sheet items of `sample-2026-11-26` too) whose latest verdict is `not_ad` / `unclear` has effective bounds with IoU ≥ 0.5 to the segment.

Other open items on the same stretch (a `D` item on the model's hidden entry) are independent questions; the assessor may see both.

### 8. The cut-off is a date variable, not `published_at`

`AI_USER_SEGMENTS_SINCE` is compared with `GREATEST(markups."createdAt", markup_time_intervals."updatedAt")`, the judge's dating of a markup. A markup made before the AI row was published but after the cut-off is taken: the user marked a fresh video, the AI published a day later, and the segment must not vanish then. `published_at` as the cut would lose exactly those and would keep the old queue growing.

Moving the date back is how the old queue could be let in later; that is the backlog item's decision, not this change's.

### 9. Who must skip user entries

- `ai regate` `place()`: a `source: "user"` entry and a `glued` hidden entry never move (without this a user entry fails `accepted()` for want of a confidence and is hidden).
- Backlog pass (`backlog.go`): a user entry stays served whatever the second model found.
- `ai judge`: `Video.Entries` (signals, the LLM request, items, baselines, `allKept`) are the non-user entries; `conflicts()` gets every served entry, so a markup that became an entry is no conflict; a row with no own entry is skipped. Otherwise a dislike on a user's segment could withdraw the model's row.
- `scripts/import-below-threshold.js --served`: never samples a user entry.
- `ai/audit` `itemSource`: a `user markup` first line is its own source.
- Dashboard panels that count or join served entries as the model's.

Serving, votes, `--recompute-ratings`, the admin send-to-review link and the review page need nothing: they go by bounds.

### 10. Off removes what the pass added

With the switch off the tick runs the same derivation with an empty user set over the rows that hold a user entry or a `glued` one (one query; none before the first switch-on), then clears its heartbeat. Open `U` items stay in the queue; a keep on one still serves the stretch, as an assessor's entry.

### 11. The serving rules get one page

`docs/ai-first-overview/{ru,en}.html` open with a table "situation → what the viewer gets" covering the old rules and these, then one short block per rule: who decided it and when, its switch, where it lives (spec, reference section). The overview is already bound to every conceptual change by CLAUDE.md, so a second document would only drift from it.

## Precision first: how this could serve a wrong segment

- **A shown user segment is not an ad.** Accepted by the owner (2026-11-26). Bounded by: the same segment is served today on every video without an AI row; author rating ≥ 0, at least `AI_MIN_SEGMENT_SECONDS`, only markups after the cut-off; an urgent item at once; `not_ad` removes it and nothing serves it again; the author deleting the markup removes it within a tick. Not bounded in length (out of scope, see Risks).
- **A glue extends an ad by a stretch that is not one.** Accepted by the owner, limited to `AI_USER_GLUE_SECONDS`; never on an entry an assessor confirmed; undone when the markup goes; no assessor sees it unless a signal sends it (Risks).
- **An intro or credits segment is wrong.** As on the human path; never over an AI entry.
- **Another writer moves or misjudges a user entry.** Decision 9.
- **Two writers interleave.** Lock order below; the row transaction re-reads segments, items and the row under the locks and derives again.
- **A stale item is kept.** The entry it creates was checked by an assessor in the player.

## Locks and transactions

One transaction per changed row: `video_calculateds` `FOR UPDATE` (`lockVideoCalculated`; the calculator and the vote handlers take it first too, so the segments read after it are the committed ones) → the AI row `FOR UPDATE` → read segments, items, keeps → derive → `UPDATE` the row (ratings through `calculator.WithVoteRatings` when an entry entered `data`) → `review.Add` (the batch row last, the judge's order). No `publishLock`: only this pass writes `ai-user-*` sheets and `flock` keeps two ticks apart. The decide route's batch → AI row order never meets it, since `review.Add` never picks a part someone holds or has a verdict in. A row that fails is logged and counted, the others go on.

## Rollback

- **Switch**: `AI_USER_SEGMENTS_ENABLED=off` and a redeploy with the running sha; one tick later no row serves a user entry or hides a `glued` one. `AI_FIRST=off` remains the global kill switch.
- **Previous image**: no table or column is new. On data the pass wrote, the previous image would serve user entries as they are, `ai regate` would hide them as `confidence`, the judge would judge them and a `glued` model entry would stay hidden for good. So switch off first, wait for one tick (log line `ai users: off, N rows cleared`), then roll the image back. The heartbeat row is cleared by the same tick. `review` entries made by keeps on `U` items and open `U` items are ordinary to the previous image.

## Risks / Trade-offs

- [A very long junk segment is served until an assessor answers: the sample has user segments of 7 to 19 minutes] → urgent item, viewers' votes, the author's rating gates; a length cap is left out on the owner's "show until checked" and can become a variable if the first week shows such entries.
- [A glue is never looked at by an assessor] → the dashboard counts glued entries; the limit is a variable; `docs/backlog/ai-user-glue-by-subtitle-meaning.md` is the owner's next step for it.
- [A keep on a held item under another category's AI entry is refused with `bounds_overlap`, and assessors rarely type bounds] → the page already lists the row's served entries; watch `unclear` on `U` items in the first batches before changing the absorb rule.
- [While glued, the model's part is outside the judge's signals] → rare at 20 s; a dislike on the glued entry still lowers its rating.
- [About 141 intro / credits segments return at switch-on, one of them 20 minutes long] → as served before the AI rows existed; the dashboard row lists them.
- [Every minute the pass reads a few hundred rows] → three indexed set queries; a write only on change.

## Migration Plan

Deploy with the switch unset (nothing changes; the `ai users` line exits after its cleanup query). The owner sets `AI_USER_SEGMENTS_SINCE` to the switch-on moment and `AI_USER_SEGMENTS_ENABLED=on`, then redeploys with the running sha. Rollback as above.

## Open Questions

- Whether two or more authors should lift the glue limit (owner, 2026-11-26: "especially when several users marked it", said before the limit was set). Read here as no; it is a one-condition change in the classification.
- Whether `not_ad` on a user's segment should cost its author rating: out of scope, worth a look once `U` verdicts exist.
