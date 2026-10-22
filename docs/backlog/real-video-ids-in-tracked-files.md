---
worth: yes
where: test/fixtures/review-sheet.md
added: 2026-10-22
---
# real-looking prv video ids in tracked files

Six distinct prv video ids (owner id + video id, not the `-1_456…` placeholder form) sit in tracked files from before 2026-10-22: `test/fixtures/review-sheet.md`, `test/fixtures/review-sheet.key.tsv`, `test/review-sheet.test.js`, `test/e2e.js`, `docs/plans/completed/20261014-timeweb-migration.md`, `docs/plans/completed/20261015-assessor-review-page.md` and `docs/backlog/video-calculateds-duplicate-and-null-rows.md`. They identify videos of the private product (the eval repo's data policy forbids them; this repo has no such test). Found by the AI-first plan's acceptance check (Task 10); the AI-first branch added only placeholders.

To do: replace them with placeholders (`-1_456000…`, consistent across the review-sheet fixture, its key, its test and `test/e2e.js`), describe the rows in the docs without the id, and consider a policy test like the eval's `TestNoVideoIDsInTrackedFiles`. The history keeps the old ids (the repo is private; rewriting history is not worth it).
