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
