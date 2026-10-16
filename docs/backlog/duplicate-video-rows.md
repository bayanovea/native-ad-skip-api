---
worth: yes
where: prv/repository/video.js:5
added: 2026-10-16
---
# several videos rows per native_id split markups for one video

No unique constraint on `videos.native_id`; `findByNativeIdAndDuration` creates a new row when the claimed duration is more than ±1 s off every existing row, and find-then-create races. 12 native_ids have more than one row in the 2026-10-15 dump. Markups for one real video get split across rows, which weakens its consensus. `prv/repository/moderation.js` carries a CTE workaround.

Work already done, not shipped: the ±2 s tolerance change and the research doc (with a one-time merge script) are parked in `git stash` ("duration tolerance ±2s … parked 2026-10-15"). To ship: pop the stash, run e2e, commit, run the merge script on prod.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
