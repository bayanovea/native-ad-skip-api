---
worth: yes
where: prv/routes/votes.js:79
added: 2026-10-16
---
# vote deletion decrements the voter's rating and leaves the segment rating unchanged

`GET /votes/:id/delete` (Grafana) looks up the User by `vote.user_id` (the voter) and decrements that user's rating. Creating a vote never changed the voter's rating: `updateRatingByVote` changes the markup authors' ratings. So deleting a vote changes an unrelated user's rating, does not undo the authors' change, and leaves `prv_calculated_segments.rating` and `video_calculateds.data` with the vote still counted.

Also: the not-found branch sends 404 inside the transaction and falls through to the 201 (`ERR_HTTP_HEADERS_SENT`), and `user.decrement('rating', { by }, transaction)` passes the transaction as a third argument, which Sequelize ignores.

Fix: reverse what the POST did (segment rating in both places, authors through `userService` with the negated delta), in one transaction passed as `{ by, transaction }`.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
