---
worth: later
where: ai/pipeline/chapters.go:63
added: 2026-11-02
---
# AI: tune the chapter check's edge (`AI_CHAPTER_EDGE_SECONDS`) on verdicts

The chapter check serves an entry at a chapter's bounds when both edges are within
`AI_CHAPTER_EDGE_SECONDS` (default 10) of the entry's. The default rests on 10 entries of a 99-row
prod sample (2026-10-28) and on the owner's player check of 3 videos. A chapter edge may move the
entry outward by up to that much on each side, so a topic chapter that happens to sit near the ad
("Альтернативные аксессуары и зарядка" 660–748 for an entry 652–738) skips up to 10 s of content.

Measure after 2–3 weeks with the check on:

- `T` items: the latest keep's bounds against the chapter's (in `flagged_by`) and the entry's: how
  often the assessor took the chapter (`bounds_source = 'chapter'`), typed something in between,
  or kept the AI bounds;
- `source: "chapter"` entries in an `ai-served` blind sample (`import-below-threshold.js --served`):
  `not_ad` and bounds verdicts on them, edge by edge (start moved out vs end moved out).

Possible outcomes: a narrower edge, an asymmetric one (the lead-in rule: an earlier start is
usually right, a later end less so), or no change.

Two small things to settle at the same time:

- the dashboard's "ad chapters with no entry" panels match titles with `~*` on Cyrillic; check
  prod's `SHOW lc_ctype` (a `C` locale does not fold Cyrillic case, so "РЕКЛАМА" would not match);
- the judge prompt marks `(bounds by review)` but not chapter bounds (`ai/judge/llm.go`,
  `judge-v1.md`); add `(bounds from a chapter)` if the judge starts withdrawing such entries.

Settles it: the verdict counts above; the edge changes only by the owner's decision.
