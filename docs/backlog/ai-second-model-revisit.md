---
worth: later
where: repository variables AI_SECOND_CLIENT / AI_SECOND_MODEL, ai/pipeline/confirm.go (secondReviewDaily), ~/Web/native-ad-skip-eval (adskip agree, internal/detector/pricing.go)
added: 2026-10-30
---
# Revisit the second-opinion model

The second opinion ran on `gpt-6-luna` from 2026-11-01 (owner, 2026-10-30, picked by price). Change
`ai-detector-roles-swap` (2026-11-05) moves it to `claude-haiku-5-5` behind the terra detector: on the held-out set
the pair serves what Sonnet → luna served (250 true ads / 39 wrong cuts against 244 / 36), but Haiku vetoes 22 % of
the true ads (luna 2 % on Sonnet's segments) and leaves 0.73 entries a video unconfirmed; only 30 `D` items a day are
created (`secondReviewDaily`), the rest stay hidden unreviewed. The full table is in the change's design.md and the
eval's `docs/iterations.md` (stage 7).

Re-check after two weeks of the pair being on, and again whenever a vendor ships a new model or reprices:

- the dashboard row "4б. Второе мнение": confirmed share, `extra`, failures, cost per video;
- the `D` verdicts (`scripts/export-review-verdicts.sh ai-second-<date>`): a keep on a `D` item is a segment the
  second model wrongly vetoed, a `not_ad` one it rightly caught; with the cap these are the first 30 a day, not a
  random sample;
- `adskip agree <terra run> <candidate run>` on the held-out set for each candidate (`claude-haiku-5-5`, Sonnet 5.5
  through a batch: `ai-second-opinion-sonnet-batch.md`, `gpt-6-luna`), with its cost from the run's metrics.

Change the model when another one vetoes clearly fewer true ads at the same wrong cuts and a cost that fits: the
repository variables `AI_SECOND_CLIENT` / `AI_SECOND_MODEL` and its `detector.Prices` row (eval first, then sync).
