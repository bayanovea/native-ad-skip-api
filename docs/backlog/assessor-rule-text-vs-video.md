---
worth: yes
where: prv/locales/review/ru.json:86
added: 2026-11-02
---
# Assessor rules say "decide by the text", the owner says the video decides

The review page tells assessors to judge the subtitle text as if there were no player (`verdict_prompt_html`, `rules_track_html`, `onb_track_html`, `item_beyond_video_warn` in `prv/locales/review/{ru,en}.json`). Owner, 2026-11-02: when the player shows an ad the text does not name (brand on screen, a banner), the verdict is `sponsor`, so the video decides. Gam already marks such stretches `sponsor` (e.g. `2026-10-24-corpus-1-misses-p1..p3`: C20, C21, C29, C36, C37, C67, C68, C82, C40, C59, C61), and the audit model flagged each of them as a verdict the text does not support, because it reads the page's rule.

To settle before rewriting the strings: what decides when the subtitles do not match the player (`track_mismatch`, an item past the end of the cut): the text, as now, or nothing (`unclear`).

Knock-on effects:
- the detector reads subtitles only, so an ad visible only on screen can never be found: in the eval such verdicts become `gold_missing` and lower the measured recall for something the model cannot see. They need a mark of their own (e.g. a per-item "only on screen" flag next to the verdict) so the eval can leave them out of recall;
- the audit prompt (`ai/prompts/audit-v1.md`) should carry the same rules the page shows, taken from the same strings rather than a paraphrase, or it keeps doubting verdicts the rules allow (it also doubted "write in the comments" as `self_promotion`, which `onb_verdicts_html` explicitly allows);
- assessors need a short post about the change.
