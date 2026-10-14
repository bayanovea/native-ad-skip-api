---
worth: yes
where: test/e2e.js:147
added: 2026-10-14
---
# 3 moderation e2e tests fail with `POST /vote failed: 404`

`make test-e2e` passes 82 of 85. The 3 failures are moderation tests, and each fails in the `postVote`
helper's assertion, where `POST /vote` returns 404 instead of 204. The same tests fail the same way on a
clean checkout of HEAD (`e7aeea2`), so the duration-tolerance changes did not cause this. Found while
verifying Task 11 of `docs/plans/20261014-timeweb-migration.md`. That task requires a green e2e run, so this
blocks it.

The vote handler can return 404 from three places (`prv/routes/votes.js:25,28,36`):

- `videoRepository.findByNativeIdAndDuration` finds no video
- the video has no `VideoCalculated` row, for example because the test never ran the calc binary or a
  moderation reject destroyed the row
- no `data` entry matches `(category_id, start, end)` exactly

Not yet investigated: which of the three it is, and which 3 tests fail. Candidates are the auto-ban tests
(`test/e2e.js:1484`, `:1517`, `:1533`, `:1582`) and the dislike helper at `:806`.
