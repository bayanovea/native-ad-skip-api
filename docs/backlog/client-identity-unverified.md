---
worth: later
where: prv/routes/votes.js:10
added: 2026-10-16
---
# client-invented identity makes ratings, bans and consensus forgeable

Every write endpoint trusts a client-generated `user_id` UUID and an unverified `prv_user_id`; there is no rate limiting. A script can mint identities to outvote real users, push an author to the -100 auto-ban, or flood fake markups. `findByNativeIdAndDuration` also creates a Video row for any string on `POST /vote`.

Why `later`: no abuse is visible yet. In the 2026-10-15 dump: 1705 users, 0 banned, 0 auto-ban decisions, about 7 markups/day. The durable fix (verify prv-signed launch params) depends on whether the client can get signed params at all, which an extension may not be able to. Settle it when `/admin/moderation` shows coordinated abuse or traffic grows. Cheap steps if it comes to that: `express-rate-limit` per IP (behind `trust proxy`), and no Video creation from `POST /vote`.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
