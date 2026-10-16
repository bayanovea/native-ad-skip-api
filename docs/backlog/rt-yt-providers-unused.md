---
worth: later
added: 2026-10-16
---
# rt/yt providers carry diverged code copies but have no data

`rt/` and `yt/` are copies of `prv/` that have drifted: their `DELETE /markups/:id` and `GET /markups/:id/delete` set `is_new = true` on soft-deleted markups too (no `deleted_at: null` filter) and skip prv's transaction (`rt/routes/markups.js:143,170`, same in yt); their validators differ from prv's. In the 2026-10-15 dump `rt_markups`, `yt_markups`, `rt_votes` and `yt_votes` have 0 rows, so none of it affects anyone. The cost is ×3 for every route, schema and calculator change.

Why `later`: it depends on whether rt/yt clients are ever going to ship. If not: delete rt/yt (routes, models, binaries, cron lines). If yes: one route module parameterised by provider, as `events.js`/`users.js` already are, and the delete fix comes with it.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
