---
worth: later
added: 2026-11-26
---
# Glue a user segment with the neighbouring AI entry by what the subtitles say there, not by seconds

The change that serves user ad segments on AI-served videos glues a user segment with a served AI entry it overlaps or adjoins when the user adds at most 20 s to it (owner, 2026-11-26); a larger addition goes to an assessor. Seconds say nothing about who is right. Owner's idea, same day, to think through: look at the transcript of the stretch the user adds. A long silence there (no cues: a visual ad the model, which reads only subtitles, cannot see) speaks for the user; cues that are clearly not an ad speak for keeping the AI's part alone or for an assessor.

What it needs: the run's transcript cues over the added stretch (`prv_ai_runs.transcript`, as `cuesOver()` cuts them), a rule for "silence" (share of the stretch with no cue) and a reader for "clearly not an ad" (an LLM call, e.g. the judge's model with the added cues; a rule on words would not carry it). The 2026-11-26 blind sample has three items with no cue at all (all start at 0:00) and nine that touch a served AI entry.

Unknown that settles it: on the pairs the 20 s limit sends to assessors, how often the transcript of the added stretch predicts the assessor's verdict and bounds. Measure it on the verdicts of sheet `sample-2026-11-26` and of the change's own assessor items before designing anything; if silence or the LLM's reading agrees with the assessors on most of them, it replaces the limit, else drop the item.
