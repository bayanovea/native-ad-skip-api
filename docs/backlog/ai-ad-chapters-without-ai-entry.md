---
worth: later
added: 2026-11-02
---
# AI: an ad chapter with no detector entry is a missed ad

A video's chapter whose title says it is an ad ("Реклама", "Нативная интеграция: <brand>", a title
with `erid`) and that no AI entry overlaps is an ad the detector missed: recall the chapter check
(`AI_CHAPTERS_ENABLED`, `ai/pipeline/chapters.go`) does not cover, because that check only refines entries the
detector and the second opinion already agree on.

Measured 2026-11-02: on the eval corpus most of the 24 keyword ad chapters with no human label were
real ads nobody marked; on a random sample of 99 prod `published` rows (dump 2026-10-28) every one of
the 7 ad chapters already had a served `high` entry, so the gain on what the detector takes is not
seen yet. Turning such a chapter into an entry needs the title classified (a keyword match also hits
news about ads: "Законопроект о запрете рекламы", "спонсоров войны"), e.g. a review item first.

Settles it: the count of ad chapters with no entry, from the chapters every run stores since
2026-11-02 (`prv_ai_runs.chapters`; the AI dashboard's row 4в counts them against `data` ∪ `hidden`),
not another sample fetch.
