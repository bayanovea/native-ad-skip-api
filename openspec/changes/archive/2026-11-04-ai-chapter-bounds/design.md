# Design

## Context

`ai detect` fetches the yt-dlp info JSON in `fetch()` (`ai/pipeline/detect.go`), uses its duration and tracks and throws the rest away; `ytdlp.Runner.Info` already returns the raw bytes next to the parsed `Info`. On the batch path the answer is resolved on a later tick by `poll()`, which rebuilds the run from `prv_ai_runs` (transcript) and calls `finish()`; the manual and `messages` paths call `finish()` right after the call. `finish()` runs one transaction: the queue row `FOR UPDATE`, `entries()` (confidence → length → second opinion), `publish()` (locks `video_calculateds`, reads the votes' ratings, inserts the AI row), then `record()` for the second opinion (confirmation row, `D` items via `review.Add`, which locks a `prv_review_batches` row). prv's info JSON carries `chapters` (`start_time`, `end_time`, `title`) exactly when the description has timecode lines (eval corpus, 2026-11-02: 189 of 609).

## Goals / Non-Goals

**Goals:**
- Chapters available at `finish()` on every path, stored once per run.
- A pure, unit-testable chapter step between `entries()` and `publish()`.
- One more `kind = 'ai'` item source that reuses `review.Add` and the review page as they are, plus a way to put a chapter's bounds into the verdict inputs.

**Non-Goals:**
- Touching the synced eval packages (`ai/ytdlp`, `ai/transcript`) or the detector prompt.
- Any change to `applyVerdict`, `ai regate`, the judge or serving.

## Decisions

- **Time only, title only for review (owner, 2026-11-02).** Both edges within `AI_CHAPTER_EDGE_SECONDS` of the entry → the chapter's bounds; the title is not read, because in the owner's player check the chapters that agreed at both edges were exact (including ad parts with no words) and the detector plus the second opinion already decided that the stretch is an ad. One edge near → review only, and only under an ad-titled chapter: on the 99-row sample the time-only version of that rule sent 19 entries, mostly topic chapters whose head or tail the ad shares ("Манты" 1909–2127 for an ad 2108–2127); the keyword version sends 3, the owner's cases B and C among them. A keyword false hit ("Законопроект о запрете рекламы") costs one review item, never a served second. Rejected: a model call to classify titles (cost and a new failure mode for a timing refinement), and the backlog's "an ad chapter becomes an entry by itself" (the 16:48–25:05 chapter for an ad ending 18:03 shows a chapter alone is not trusted).
- **Read chapters from the raw info JSON in product code**, not by adding `Chapters` to `ytdlp.Info`: the field would have to go through the eval repo and a sync for a struct tag, while `fetch()` already holds the raw bytes. A local `struct{ Chapters []chapter }` unmarshalled from them; a parse failure is logged and treated as no chapters (the info already parsed once, so this only happens on a type change upstream).
- **Store on `prv_ai_runs.chapters`** (JSONB `[{start, end, title}]`, NULL for runs before this change, `[]` for none), written by `startRun()` with the transcript, read by `poll()`'s existing `LATERAL` select. Rejected: inside `storedTranscript.Meta` (`transcript.Meta` is a synced type) and a separate table (one row per run either way). Stored with the switch off too, so the "ad chapters with no entry" count (`docs/backlog/ai-ad-chapters-without-ai-entry.md`) and the effect of switching on can be measured on data collected before.
- **Where the step runs.** `applyChapters(served, chapters, edge, minSeconds) (served []Entry, toReview []chapterMatch)` in `ai/pipeline/chapters.go`, called in `finish()` after `entries()` and before `publish()`, only when `AI_CHAPTERS_ENABLED` is on. Entries are walked in start order; a move is checked against the other served entries' bounds as they stand (moved ones included), so served entries never overlap. Chapter bounds are rounded inward (`ceil(start)`, `floor(end)`) as cue bounds are. Hidden entries are never touched: they reach viewers only by a verdict, which carries its own bounds.
- **`source: "chapter"`.** The entry keeps `category_id` and `confidence`. `source` already has two values the extension ignores (`ai`, `review`), so a third needs no client change. `applyVerdict` keeps an entry's `source` unless the verdict moves it (`review`), `ai regate` and `--recompute-ratings` do not read `source`, and `import-below-threshold.js --served` skips only `source: review`, so chapter-bound entries stay in the blind served sample.
- **Review items: sheet `ai-chapter-<date>`, prefix `T`, priority `important`**, through `review.Add` like the `D` items (`T` is free: A judge, B below threshold, C sheets, D second opinion, K conflicts, M admin, S served). `important`, as the second opinion's: the viewer is served the AI bounds meanwhile, so it is a timing correction, not an `urgent` "is this an ad" question. `flagged_by` = `["chapter: «<title>» <m:ss>–<m:ss>, <near edge> within <d> s", "entry: <category> <confidence>, <len> s"]`. An entry with a `T` item has an open ai item, so the judge (`openAiItems`) sends no second item for it while it is undecided; accepted, the assessor sees the same entry.
- **The keyword list** lives in `chapters.go` as one case-insensitive regexp (`реклам|интеграц|спонсор|партн[её]р|промокод|скидк|erid|при поддержке|купон|розыгрыш`, the list of the 2026-11-02 measurement) and once more in the dashboard's "ad chapters with no entry" SQL (`~*`), tagged `/* chapters.go adTitle */` so a change finds both.
- **Review page.** `prv/repository/review.js` adds `chapters` (those overlapping the window) to the item payload from the same run row as `transcript`; `admin-review.js` renders them above the transcript with a "use these bounds" button that fills the inputs and sets the bounds source to `chapter`; `BOUNDS_SOURCES` gains `chapter`. Shown before a verdict: the chapters are the author's public timecodes the assessor sees in the player anyway; `flagged_by` (which source flagged the item) stays blind.
- **Config.** `AI_CHAPTERS_ENABLED` (`on` | `off`, default `off`) and `AI_CHAPTER_EDGE_SECONDS` (int ≥ 1, default 10, invalid = startup error of a detect tick) in `ConfigFromEnv`; Node reads neither.

## Precision-first

The change can serve a wrong second in one way: an entry moved outward to a chapter's edge, up to `AI_CHAPTER_EDGE_SECONDS` per side, when the chapter is a topic chapter whose edges happen to lie near the ad's (on the sample: "Альтернативные аксессуары и зарядка" 660–748 for an entry 652–738). It does not serve a new segment: only an entry that both models and every rule already serve can move, a chapter alone never creates or un-hides one, and a moved entry stays within N s of what the detector said. The owner accepted that edge for the exactness of agreeing chapters (2 of 3 exact in the player, including visual ad parts with no words, which inward-rounded cue bounds cut). Measured after switching on: the `S` blind served sample includes chapter-bound entries, and a `not_ad` / bounds verdict on one shows up on the dashboard row.

## Locks and transactions

Everything stays in `finish()`'s one transaction, in today's order: the `prv_ai_videos` row `FOR UPDATE` → `video_calculateds` (`publish()`, ratings read on the final bounds) → the AI row insert → `prv_review_batches` row (`review.Add`, first the second opinion's `D` items, then the `T` items). That is the second opinion's order (queue row, `video_calculateds`, batch row), consistent with the judge's AI row → batch row and with `applyVerdict`'s batch row → AI row only because the batch `review.Add` picks is never one someone holds or has a verdict in. Parsing and matching happen before the transaction opens or inside it without I/O.

## Risks / Trade-offs

- [The keyword list misses an ad chapter title ("Наш друг Яндекс")] → the entry keeps its AI bounds; nothing worse than today. The dashboard row's "ad chapters with no entry" and the stored chapters let the list be widened on data.
- [A channel titles every chapter with a brand (the "Нативная интеграция: <brand>" channel is 37 of 54 ad-chapter videos in the eval corpus)] → skew of the gain, not of precision; the both-edges rule does not depend on titles.
- [Chapter times from a re-cut video] → the run's chapters come from the same info JSON as the duration that picked the `videos` row, so they share the cut the AI row is keyed on.
- [Review volume above the sample's ~3 per 100 videos] → the dashboard row shows open `T` items; `AI_CHAPTERS_ENABLED=off` stops new ones without touching served rows.

## Migration Plan

1. Deploy with `AI_CHAPTERS_ENABLED` unset: runs start storing chapters; nothing served changes.
2. After a day, the dashboard row shows runs with chapters and what the check would do is reproducible from them; the owner sets the repository variable `AI_CHAPTERS_ENABLED=on` and redeploys with the running sha.

Rollback: the previous image never reads `prv_ai_runs.chapters` (nullable, left in place) and serves `source: "chapter"` entries as any entry (Node passes `data` through, its `applyVerdict` keeps an unknown source); `T` items are ordinary ai items to it; a verdict with bounds source `chapter` is stored history it never validates again. `AI_CHAPTERS_ENABLED=off` is the kill switch for new publications; already moved entries stay (a verdict corrects one).

## Open Questions

- The default `AI_CHAPTER_EDGE_SECONDS` 10 rests on 10 sample entries; widen or narrow after the first weeks of `T` verdicts and served-sample verdicts on chapter entries.
