---
worth: later
where: grafana/dashboards/ai-pipeline.json ("Модель не нашла рекламу, а пользователи разметили", "Пропуски модели: какие видео")
added: 2026-11-01
---
# Prod misses: rows the model called clean while users marked an ad

The dashboard's misses pair counts AI rows with empty `data` whose `native_id` has a live human sponsor / self_promotion markup. It went 6 → 13 between the checks of 2026-10-30 and 2026-11-01 (518 rows ready to serve). Nothing else looks at these rows: the judge skips empty rows, so a miss reaches an assessor only by hand.

Most of the 13 human markups are old (December–February): the detector is working through old popular videos that users marked long ago, so growth may be the backlog, not a recall drop. The corpus pass (`corpus-review-pass-boost.md`) found that a third of such "misses" are human labels that are not ads (28 of 83) and that the confirmed ones give no prompt rule (step 2).

Unknown that settles it: whether the share keeps growing once the old-video backlog is through. Watch misses / ready_videos on the dashboard checks; act when it rises for a week, or when misses with a recent human markup (after the AI row was published) appear. Then: export the misses table as a `K`-style miss sheet for the assessors (the eval repo's `review -misses` path) and score the confirmed ones against the current prompt before touching it.

## The pair counts more than misses (audit 2026-11-04)

Both panels take every row with empty `data`, not withdrawn, so since the second opinion (2026-11-01) they also count rows the model did answer whose served entries all went `unconfirmed` (the second model's veto), and rows emptied by a short keep or a rule change: a veto is not the detector missing the ad. Their "у асессоров" column counts items whose `flagged_by` says `hidden: ` or `below the publish threshold` (`B`, `M`), so a row whose entries wait in `D` items shows 0 there. Read-only fix in `grafana/dashboards/ai-pipeline.json` (run the SQL against a seeded schema first): split the count by what `hidden` holds (empty or only `confidence` / `short` = the model's miss, any `unconfirmed` = vetoed) and count the row's open ai items by `kind = 'ai' AND video_id = c.video_id` instead of the `flagged_by` text. The same dashboard's "Результат разметки сейчас" outcome 2 lists the hidden reasons without "не подтверждено второй моделью".
