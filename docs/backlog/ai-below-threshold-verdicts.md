---
worth: later
where: ai/pipeline/publish.go (accepted), scripts/import-below-threshold.js
added: 2026-10-24
---
# Read the below-threshold verdicts, then decide the self_promotion threshold

On 2026-10-24 the 80 detector segments that publish dropped (≥ 5 s: 62 `self_promotion medium`, 8 `low`, 10 at the 5-s edge) went to the assessors as `ai-below-threshold-2026-10-24-p1…p3` (optional, sheet items: a verdict changes nothing for viewers). When the three batches are done: `scripts/export-review-verdicts.sh ai-below-threshold-2026-10-24` and the "ad" share among the `self_promotion medium` items. ≳ 80 % → lower `self_promotion` to `medium` in `accepted()` (one line) and re-score the held-out gate in the eval repo first; lower → keep the threshold (precision-first). The 82 segments under 5 s were left out on purpose (`--min-seconds 5`): mostly 1–5 s `sponsor high` bursts in four streams (e.g. `-1_456000906`, 27 of them), which look like a repeated sponsor jingle; worth one look in the eval repo, separately.

Re-running the script later imports only new detections (duplicates by native_id, bounds, category). The judge never looks at empty AI rows; the dashboard's last-row "misses" pair (empty answer + human sponsor markup) is the only view of the model failing on "no ad" videos. If that count grows, consider an ai item for a human sponsor markup on an empty AI row (touches `ai/judge/judge.go`'s due query).
