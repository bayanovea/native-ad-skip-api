---
worth: later
where: ~/Web/native-ad-skip-eval (adskip sheet, adskip review, adskip paired)
added: 2026-11-01
---
# gpt-6-luna's held-out SCORE is measured against gold it never got reviewed on

On the held-out set Claude v2.2 was gated on (217 videos, reviewed gold), luna as a standalone detector scores −0.39 against Sonnet's 0.40 (paired difference −0.79, 95 % CI [−1.38, −0.38]): it removes more ad time (62 % vs 52 %) but cuts 3035 s of content against 374 s. The comparison is biased against luna: the reviewed gold was built from sheets of the Claude runs, so every stretch only luna marked is judged by the human labels alone, and an ad nobody labelled counts as content wrongly cut.

A fair number needs luna's own stretches reviewed: `adskip sheet` over the luna run `2026-10-31-gpt-6-luna-v2.2-openai-nt` (stretches no reviewed gold covers), a blind batch for the assessors, `adskip review` with the verdicts, then `adskip score` / `paired` again. Opus is not a candidate (owner, 2026-11-01); only luna, the model already in prod as the second opinion.

Unknown that settles it: whether a fair luna score would change any decision. Today it would not: luna only vetoes Claude's segments (`ai-second-model-revisit.md`), and as a detector it would have to close a 0.79 gap, while 276 of its 493 segments are self-promotion. Worth doing if luna ever becomes a detector candidate (e.g. a cheaper primary for low-traffic videos) or if `ai-second-only-segments.md` needs its precision. Cost: no model call, assessor time for the sheet (luna's extra stretches: 145–180 at IoU 0.3–0.5 on this set).
