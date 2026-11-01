---
worth: later
where: ai/audit (Finding.Action), prv/routes/admin-review.js (renderAudits), prv_review_audits.hidden_*
added: 2026-11-01
---
# Acting on audit findings

`ai audit` only reports (owner, 2026-11-01: actions later, once there is data). Every finding already carries a typed `action` (`blind_subset` with batch / sample / exclude, `backlog_item`, `eval_import`, `reviewer_note`). Next step: a "Do it" button per finding next to "Hide", with per-finding state, and for the action types the owner nearly always accepts, the action itself without a click: a blind subset batch through `scripts/subset-review-sheet.js` + the importer's logic, a backlog file, a note for the assessors' chat. Why later: hide is per audit today, so the history says which audits were dismissed, not which suggestions were right; a few weeks of rows with a per-finding accept / dismiss are the input for picking what to automate.
