---
worth: yes
where: prv/routes/votes.js:102
added: 2026-10-16
---
# update-rating writes an unvalidated query param into users.rating

`GET /votes/user/:id/update-rating` does `user.update({ rating: req.query.rating })`: no parsing or validation and no audit record. A missing param writes `undefined`, a non-numeric one gives a DB error → 500. Ratings drive the `≤ -2` gate and the `≤ -100` auto-ban, so a manual override is worth a trace.

Fix: `query('rating').isInt().toInt()` + `validateRequest`; log the change (or a `prv_admin_decisions`-style row).

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
