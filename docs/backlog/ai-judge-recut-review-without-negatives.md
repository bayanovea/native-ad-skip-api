---
worth: later
where: ai/judge/rules.go (re-cut rule)
added: 2026-10-31
---
# Re-cut alone sends a correct AI row to review

A new re-cut without new negatives makes `rules` send every served entry to review, though the AI row reaches only players of its own cut, where its segments were checked. First evidence, sheet `ai-judge-2026-10-30`: one video (`videos.id` 104124), 4 items, all kept by the assessor, no bounds corrected; only A4 changed category (`self_promotion` → `sponsor`). Human time spent, nothing to fix.

Decide after a few more `ai-judge-*` sheets: if re-cut-only items keep coming back as keeps, drop the review for a re-cut without new negatives (record it in `signals` only). The batch said nothing about the LLM's `withdraw` precision (no LLM call), so `ai-judge-autonomy-flag.md` still waits for its evidence.

Side note: one `self_promotion` entry the assessor called `sponsor`. If that confusion is systematic on the gold, `accepted()`'s `high` bar for `self_promotion` also hides sponsors; check in the eval repo before touching thresholds (`ai-below-threshold-verdicts.md`).
