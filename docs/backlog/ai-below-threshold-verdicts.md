---
worth: later
where: ai/pipeline/publish.go (accepted), scripts/import-below-threshold.js
added: 2026-10-24
---
# Read the below-threshold verdicts, then decide the self_promotion threshold

On 2026-10-24 the 80 detector segments that publish dropped (≥ 5 s: 62 `self_promotion medium`, 8 `low`, 10 at the 5-s edge) went to the assessors as `ai-below-threshold-2026-10-24-p1…p3` (optional, sheet items: a verdict changes nothing for viewers). When the three batches are done: `scripts/export-review-verdicts.sh ai-below-threshold-2026-10-24` and the "ad" share among the `self_promotion medium` items. ≳ 80 % → lower `self_promotion` to `medium` in `accepted()` (one line) and re-score the held-out gate in the eval repo first; lower → keep the threshold (precision-first). The 82 segments under 5 s were left out on purpose (`--min-seconds 5`): mostly 1–5 s `sponsor high` bursts in four streams (e.g. `-1_456000906`, 27 of them), which look like a repeated sponsor jingle; worth one look in the eval repo, separately.

Re-running the script later imports only new detections (duplicates by native_id, bounds, category). The judge never looks at empty AI rows; the dashboard's last-row "misses" pair (empty answer + human sponsor markup) is the only view of the model failing on "no ad" videos. If that count grows, consider an ai item for a human sponsor markup on an empty AI row (touches `ai/judge/judge.go`'s due query).

## Result (2026-10-26, all 80 items decided by Gam, one reviewer)

| detector | items | ad | other |
|---|---|---|---|
| self_promotion medium | 63 | 62 | 1 unclear (B17) |
| self_promotion low | 5 | 5 | — |
| self_promotion high (5-s edge) | 3 | 3 | — |
| sponsor medium (5-s edge) | 3 | 2 | 1 not_ad (B41) |
| sponsor high (5-s edge) | 4 | 4 | — |
| sponsor low | 2 | 0 | 2 not_ad (B30, B42) |

`self_promotion medium` reads 98 % ad, over the 80 % bar → candidate: lower `self_promotion` to `medium` in `accepted()`. `sponsor low` stays out (0 of 2). Caveats: one reviewer; verdicts judge the text, not the viewer's experience of the cut; the eval held-out gate must be re-scored with the new threshold first (precision-first). Owner's decision pending.

## Decision 2026-10-26: keep `self_promotion` at `high`

The eval disagrees with the prod batch. Held-out v2.2 (217 videos, reviewed gold, IoU 0.3) re-scored with `self_promotion: medium` in `cmd/adskip/scorecore.go`: SCORE 0.40 → 0.35 (ad removed 52 % → 57 %, wrongly cut 374 s → 663 s); claude -p run 0.41 → 0.40; dev 0.39 → 0.13. Per-segment precision of `self_promotion medium` against gold: 0.74 / 0.82 / 0.67 (batch / cli / dev) vs 0.98 on the prod batch. Part of the gap is assessor-confirmed: several of the 18 held-out medium FPs carry `model_wrong` verdicts (C29, C84, C159, C160), so it is not only missing gold; the rest of them were never in a sheet. The prod batch is 50 requested videos, text-only verdicts, one reviewer. Stake on prod: 118 raw `self_promotion medium` segments vs 121 published `high`.

Nothing in the review queue settles it: `2026-10-24-corpus-1` (177) and `-misses` (83) are built under the product thresholds / from human labels. What would: a small blind sheet of the held-out + dev `self_promotion medium` false positives without a verdict (~15–20 items), then the re-score above; lower only if SCORE with `medium` ≥ SCORE with `high` (precision-first).

Checked 2026-10-26: there is no blind sheet to build. `adskip sheet` over the four v2.2 runs (held-out batch + cli, dev + rerun) yields 5 unreviewed stretches, all dev, so the held-out `self_promotion medium` FPs are already decided or sit on human labels of another category (e.g. `-1_456000904`: a sponsor label 0–4222 s covers the whole video, its 155 s of medium FPs count as ad time, not wrong cut; `-100000007_456240037` 1:06:24–1:07:10 sits on a credits label). The extra wrong cut under `medium` is spread over ~12 videos, the two largest (`-1415705_456247661`, 112 s) assessor-confirmed `model_wrong` (C159, C160). Closed; reopen with new gold, e.g. after the corpus-1 review lands and a corpus-1 re-score with `medium` reads no worse than `high`.
