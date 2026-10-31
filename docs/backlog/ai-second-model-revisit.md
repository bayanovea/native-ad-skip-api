---
worth: later
where: repository variable AI_SECOND_MODEL, ~/Web/native-ad-skip-eval (adskip detect -transport openai, adskip agree, internal/detector/pricing.go)
added: 2026-10-30
---
# Revisit the second-opinion model

The second opinion runs on `gpt-6-luna` (owner, 2026-10-30), picked by price before any measurement: ~$0.006 per video against ~$0.07–0.09 for `gpt-5`. A cheap model that misses ads vetoes good segments into the assessors' queue; one that agrees with everything vetoes nothing.

Re-check after two weeks of the switch being on, and again whenever OpenAI ships a new model or reprices:

- the dashboard row "4б. Второе мнение": confirmed share, `extra`, failures, cost per video;
- the `D` verdicts (`scripts/export-review-verdicts.sh ai-second-<date>`): a keep on a `D` item is a segment the second model wrongly vetoed, a `not_ad` one it rightly caught;
- `adskip agree` on the held-out set for each candidate (`gpt-6-luna`, `gpt-6.1-terra`, `gpt-5.6-luna`, at effort `low` / `medium`), with its cost from the run's metrics.

Change the model when another one vetoes clearly fewer true ads at a cost that still fits the $100/month: the repository variable `AI_SECOND_MODEL` and its `detector.Prices` row (eval first, then sync); the code default follows in the same change.
