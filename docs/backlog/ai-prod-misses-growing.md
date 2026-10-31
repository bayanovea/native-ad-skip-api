---
worth: later
where: grafana/dashboards/ai-pipeline.json ("Модель не нашла рекламу, а пользователи разметили", "Пропуски модели: какие видео")
added: 2026-11-01
---
# Prod misses: rows the model called clean while users marked an ad

The dashboard's misses pair counts AI rows with empty `data` whose `native_id` has a live human sponsor / self_promotion markup. It went 6 → 13 between the checks of 2026-10-30 and 2026-11-01 (518 rows ready to serve). Nothing else looks at these rows: the judge skips empty rows, so a miss reaches an assessor only by hand.

Most of the 13 human markups are old (December–February): the detector is working through old popular videos that users marked long ago, so growth may be the backlog, not a recall drop. The corpus pass (`corpus-review-pass-boost.md`) found that a third of such "misses" are human labels that are not ads (28 of 83) and that the confirmed ones give no prompt rule (step 2).

Unknown that settles it: whether the share keeps growing once the old-video backlog is through. Watch misses / ready_videos on the dashboard checks; act when it rises for a week, or when misses with a recent human markup (after the AI row was published) appear. Then: export the misses table as a `K`-style miss sheet for the assessors (the eval repo's `review -misses` path) and score the confirmed ones against the current prompt before touching it.
