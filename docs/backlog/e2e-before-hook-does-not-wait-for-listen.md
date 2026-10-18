---
worth: yes
where: test/e2e.js:37
added: 2026-10-19
---
# e2e `before()` returns before the app listens, so the first tests can fail with ECONNREFUSED

`before()` in `test/e2e.js` starts `server.js` and then `waitForSchema()`, which polls until `markup_categories`
is seeded. Seeding happens inside `bootstrap()` (`lib/schema.js`), and `server.js` calls `app.listen()` only
after `bootstrap()` resolves, so there is a window after the seed in which the schema poll succeeds but port 3099
is not open yet. On a loaded machine (seen 2026-10-19 with a Docker image build and another container running
alongside `make test-e2e`) the first 18 tests failed with `connect ECONNREFUSED 127.0.0.1:3099` and the rest
passed once `I am alive` was logged; a rerun on an idle machine was green.

Fix: after `waitForSchema()`, poll `GET /` until it answers (same 500 ms loop, same 30 s budget), or wait for
the `I am alive` line on the server's stdout. CI runs `make test-e2e` on a shared runner, so the race can hit
there too and block a deploy for no reason.
