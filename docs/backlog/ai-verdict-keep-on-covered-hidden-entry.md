---
worth: yes
where: prv/repository/ai.js:101 (applyVerdict)
added: 2026-11-04
auto: yes
---
# A keep on a hidden entry that a served one covers is refused (400)

`applyVerdict` treats an item whose entry is gone and whose bounds lie inside a served entry as history (the absorb rule: a verdict on it is a no-op). A hidden entry lying inside a served one gets no such rule: a keep moves it towards `data`, the covering served entry is a partial overlap, and the decide route answers 400 `bounds_overlap`. The assessor can then only save `not_ad` / `unclear`, which the export and the audit read as "not an ad" for a stretch that is an ad and is served.

How a hidden entry ends up inside a served one: an absorbing keep covers only `data` entries and leaves `hidden` untouched (by design, `openspec/specs/ai-verdict-application`), so a merge over a low-confidence or unconfirmed piece leaves it inside; and the chapter check (`ai/pipeline/chapters.go` `overlapsOther`) checks the chapter bounds against served entries only, so a chapter up to `AI_CHAPTER_EDGE_SECONDS` wider than the entry can cover a hidden neighbour, whose `D` item is created in the same publish.

Failing scenario (checked 2026-11-04 with mocked models): `data` `[sponsor 100–200, source review]`, `hidden` `[sponsor 150–160, reason unconfirmed]`, its `D1` item: decide `sponsor` without bounds → `ReviewInputError bounds_overlap`, nothing written. The same keep after the entry was absorbed (no entry at 150–160) → `{changed: false}`.

Approach: in the keep branch, when the entry at `from` is not in `data` (`inData === -1`, hidden or gone) and `to` lies entirely inside an entry of `others.data` (`e.start <= to.start && to.end <= e.end`, any category, as line 101), return `{ changed: false, absorbed: 0 }`: the stretch is served already. A `to` that covers the served entry still absorbs it (the path today), a partial overlap stays 400. A served entry moved inside another served one (`inData !== -1`) stays 400. Test: in the e2e `ai review merge` test, a keep on a hidden entry the merged entry covers → 201, `ai_applied: false`, row unchanged.

Not part of the fix: a `not_ad` on such a covered entry moves it to `hidden` as `review` and leaves the covering served entry as it is, so viewers still skip that stretch. Whether that should reach the owner (or narrow the served entry) is a product question.
