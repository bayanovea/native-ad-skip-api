---
worth: later
where: eval repo (evalset corpus-1, runs, docs/iterations.md), prod review batches 2026-10-24-corpus-1*
added: 2026-10-24
---
# Does reviewing the labelled corpus give a boost? Decide after corpus-1

Owner's question (2026-10-23): before AI-first serves new videos, should the ~4 800 videos with human
sponsor / self_promotion markups be run through the detector and their disagreements reviewed?
The estimate: ~3 700 videos with a ru track, ~$95 of detect, ~1 300 review items when only
medium / low confidence is given to assessors (~3 000 for all; 44 % of the held-out v2.1 false
positives were medium / low), ~2 months of one assessor. Half of the model's real errors on held-out
came with `high` confidence, so a confidence filter hides half of what a review could find.

Decision (owner, 2026-10-24): a 150-video sample first, as an **optional** priority batch set
(`2026-10-24-corpus-1`, flagged sheet + miss sheet, eval set `~/Web/data/evalsets/corpus-1.txt`:
labelled videos not in dev / held-out, ≤ 3 per channel, 10–60 min, hash order). Assessors take it
when nothing urgent or important is open.

**When its verdicts are in** (`export-review-verdicts.sh 2026-10-24-corpus-1`, `adskip review` /
`review -misses`, flags): measure before deciding anything about the rest of the corpus:
1. Score the corpus-1 run raw vs reviewed (`score -gold all` / `reviewed`), and the share of
   flagged stretches that were unlabelled ads vs model errors (held-out v2.1: ~70 % ads). If the
   split matches held-out, the corpus adds no new error class and the full pass is only better gold.
2. Prompt gain: any new rule the verdicts suggest goes to the eval loop (dev, two repeats, then
   held-out once). The pass is worth continuing only if a rule found here moves dev SCORE by more
   than the repeat spread (±0.03) — compare with v2.1 → v2.2 (+0.11) and Sonnet → Opus (+0.20).
3. Cost per useful verdict: assessor hours spent / rules or gold corrections produced, next to the
   judge's `ai-judge-*` batches on live videos, which cost no detect run and cover videos people watch.
Then decide: continue over the whole corpus in quiet time (optional batches, ~150 videos a round),
or stop and let the judge's batches be the only review queue.

**Interim (2026-10-31, p1 + misses decided by Gam, p2–p6 open, p4 has 2 by bayanovea):**
- p1 (30 items, 28 videos): 30/30 ads, no bounds, no comments; one category change
  (C22 `self_promotion` → `sponsor`). Pace: median 22 s per item, 12 under 20 s (misses ~30 s).
  `track_mismatch` on 8 of 28 videos.
- misses (83): 52 ads the model missed, 28 `not_ad` (human labels wrong), 3 `unclear`;
  sponsor ↔ self_promotion differs from the human label in 8 of the 52.
- 100 % keeps at that pace with `Proposed as:` visible → blind agreement check first:
  batch `2026-10-24-corpus-1-p1-blind` (C7,C8,C10,C15,C17,C18,C21,C22,C24,C27,C29,C30; one per
  video; `important`, Gam excluded; imported 2026-10-31). When it is decided, compare per item
  with Gam's p1 verdicts; disagreement → re-check p1 before step 1. Export and score only after p2–p6.

**Step 1 (2026-10-31, all of p1–p6 and misses decided, blind p1 still open):** imported into the eval
store as `blind-union-corpus-1-2026-10-24` (Gam) and `misses-corpus-1-2026-10-24`; run
`…-v2.2-batch-nt-corpus1`, 133 videos scored; the sheet favours this run.
- flagged 177: 175 ads, 2 `unclear`, 0 `not_ad` (held-out v2.1: ~70 % ads); 138 proposed
  `self_promotion`, 136 kept as such; 3 category changes; no bounds, no comments.
- SCORE raw −1.05 (52 % of ad time removed, 3 050 s wrong cut) → reviewed 0.55 (69 %, 266 s), same at
  IoU 0.3 and 0.5. Reviewed `any_ad` precision 0.95 / recall 0.96 by count, 0.98 / 0.75 by seconds;
  the missed time is sponsor (recall 0.65 by seconds, start error p90 17.8 s).
- precision by confidence (reviewed): self_promotion high 0.83 (90/108), medium 0.94 (49/52); the
  high FPs are mostly category conflicts with human sponsor labels (`any_ad` high 0.94).
- misses 83: 52 ads the model missed, 28 human labels not ads (34 %), 3 unclear.
- cost: Gam ~1.0 h for the 177 flagged (median 13–22 s per item), ~1.1 h for the 83 misses.
- reading: the flagged side is the class humans do not label (self-promotion), not a model error class;
  only the misses can still give a prompt rule (step 2). The 0 % `not_ad` at 13 s per item is exactly
  what the blind batch checks: decide nothing about the rest of the corpus before it is in.

**Step 2 (2026-10-31, the 52 confirmed misses):** no new prompt rule worth a version. 36 are lead-ins /
tails of a gold stretch the model hit (783 s, boundary seconds only), 6 were predicted but dropped by the
serving filter (confidence or < 5 s, 171 s), 2 just under IoU 0.3, 8 had nothing predicted (3 208 s, of
which one whole-stream sponsor label C3 = 2 724 s; C11 / C70 of the same label are `not_ad`: check in the
player). Covered by v2.2 already: staged sketches around a pitch, narrated lead-ins, own promotion. Excluded
on purpose: show intros (the assessor marks the same kind both ad and not ad: C18 vs C41). Not in the prompt:
ready-made commercial spots at 0:00 and platform / other-show promos, ~250 s ≈ 1.3 % of ad time, at most
+0.01 SCORE: one cheap eval try at most, risk = the video's own cold opens. The 28 `not_ad` human labels:
18 content inside whole-video sponsor sweeps, 6 show intros, 4 overruns past a real ad.
