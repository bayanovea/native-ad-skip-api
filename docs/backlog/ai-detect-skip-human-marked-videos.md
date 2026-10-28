---
worth: later
where: ai/pipeline/queue.go (queueRule)
added: 2026-10-28
---
# Should the detector skip videos that already have good human markups?

With `AI_FIRST=on` a video with an AI row serves the AI segments only; its human markups stay as the judge's
signal and the fallback after a withdraw (21 of the 297 serving rows on 2026-10-28 have one). Open since the
2026-10-22 plan: whether `queueRule` should leave out videos with ≥ 2 live sponsor / self_promotion markups by
authors with rating ≥ 0, so a working human markup is never replaced by the model. Decide on the read side's
numbers once AI-first has run a few weeks: how often the judge gets a conflicting markup on such rows
(`prv_ai_judgements.signals`), and whether the AI segments on them were confirmed by assessors. If skipping,
do it in the queue (one more condition in the claim query), never as a read-time merge of the two tables.
