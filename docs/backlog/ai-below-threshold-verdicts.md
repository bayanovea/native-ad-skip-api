---
worth: later
where: ai/pipeline/publish.go (accepted)
added: 2026-10-24
---
# Lower the self_promotion threshold to medium once the eval agrees

Since 2026-10-27 (`docs/plans/completed/20261027-ai-hidden-entries.md`) below-threshold segments live in `hidden` and their review items are ai items, so a keep verdict serves the segment; the 2026-10-24 sheet goes through `scripts/adopt-review-items.js` (Ops). What stays open is the rule itself: whether `accepted()` should serve `self_promotion medium` without a verdict. The unknown that settles it: new gold on which SCORE with `medium` ≥ SCORE with `high` (precision-first), e.g. a corpus-1 re-score after that review lands. Then change `accepted()` (one line; the eval repo's `cmd/adskip/scorecore.go` first), deploy and run `ai regate` once: unpinned `confidence` entries move into `data`, verdicts stay.

## Evidence so far

Prod batch `ai-below-threshold-2026-10-24` (80 items ≥ 5 s, all decided by Gam, one reviewer, text-only verdicts):

| detector | items | ad | other |
|---|---|---|---|
| self_promotion medium | 63 | 62 | 1 unclear (B17) |
| self_promotion low | 5 | 5 | — |
| self_promotion high (5-s edge) | 3 | 3 | — |
| sponsor medium (5-s edge) | 3 | 2 | 1 not_ad (B41) |
| sponsor high (5-s edge) | 4 | 4 | — |
| sponsor low | 2 | 0 | 2 not_ad (B30, B42) |

The eval disagrees (2026-10-26, why the threshold stayed `high`): held-out v2.2 (217 videos, reviewed gold, IoU 0.3) with `self_promotion: medium` reads SCORE 0.40 → 0.35 (ad removed 52 % → 57 %, wrongly cut 374 s → 663 s), claude -p run 0.41 → 0.40, dev 0.39 → 0.13; per-segment precision of `medium` 0.74 / 0.82 / 0.67 (batch / cli / dev) vs 0.98 on the prod batch. Several held-out medium FPs are assessor-confirmed `model_wrong` (C29, C84, C159, C160). No blind sheet can close the gap: `adskip sheet` over the four v2.2 runs leaves 5 unreviewed stretches, all dev; the rest are decided or sit on human labels of another category (e.g. `-1_456000904`, a sponsor label over the whole video).

## Side notes

- 82 segments under 5 s were left out of the 2026-10-24 sheet, mostly 1–5 s `sponsor high` bursts in four streams (e.g. `-1_456000906`, 27 of them) that look like a repeated sponsor jingle; worth one look in the eval repo. They are now `hidden` with reason `short`; `import-below-threshold.js --min-seconds 0` sends them to review.
- The judge never looks at rows with empty `data`; the dashboard's "misses" pair (empty answer + human sponsor markup) is the only view of the model failing on "no ad" videos. If that count grows, consider an ai item for a human sponsor markup on such a row (`ai/judge/judge.go` due query).
