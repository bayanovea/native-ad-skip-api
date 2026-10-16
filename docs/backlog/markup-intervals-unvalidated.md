---
worth: yes
where: prv/routes/markups.js:23
added: 2026-10-16
---
# POST /markup does not validate intervals and writes them outside a transaction

Only "`data.intervals` is an array" is checked. Each `start`/`end` goes through `Math.round` unchecked; a missing field gives NaN → DB error → 500 after the markup row was created, since the markup and its intervals are separate inserts in a loop with no transaction. Empty arrays, `end <= start`, negatives and any number of intervals are accepted. In the 2026-10-15 dump: 4 markups with no intervals, 1 interval with `end <= start`. Small, but it feeds the consensus directly. Same code in rt/yt.

Fix: validate each interval (finite, `0 <= start < end`, count cap), reject an empty array, create the markup + intervals in one transaction.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
