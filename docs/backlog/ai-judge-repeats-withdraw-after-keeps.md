---
worth: later
where: ai/judge/llm.go, ai/judge/judge.go (what the LLM call is shown), ai/prompts/judge-v1.md
added: 2026-11-19
---
# The judge withdraws the same row again after assessors kept it

Video 106686 (`videos.id`): the LLM judge withdrew its AI row four times (judgements 1133, 1434, 2983, 3193;
2026-11-07, 11-08, 11-11, 11-13), each time for the same reason: viewers' markups put sponsor ads at 572–722 s and
1275–1424 s. After each withdraw the review items were decided, all 12 kept, and the verdicts restored the row. Each
round costs the assessors a batch and takes the row off the air for hours; the audit's `judge_false_alarm` rule sees it
but nothing feeds it back to the judge.

The judge is not told that assessors already kept these entries, and the viewers' intervals it reacts to may be ads
the detector missed rather than evidence against the served ones: a miss is not a reason to withdraw what is right.

Options, to weigh when it recurs on more videos: show the LLM the row's entries kept by a verdict (`entryKeeps`) and
forbid a withdraw that rests only on signals older than those verdicts; or turn "humans mark an ad where AI has none"
into a review item for the missed interval instead of a withdraw. Check first how many videos have two or more LLM
withdraws each followed by keeps (`prv_ai_judgements` × `prv_review_verdicts`).
