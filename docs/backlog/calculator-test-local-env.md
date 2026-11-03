---
worth: later
where: calculator/integration_test.go (connectTestDB), the repo's local .env
added: 2026-11-02
auto: yes
---
# `go test ./calculator` fails locally

`connectTestDB` loads `.env` / `../.env` when they exist, and the local `.env` sets `DB_USER` and `DB_HOST=host.docker.internal`, so plain `go test ./calculator` on the Mac runs `TestIntegration` against a host it cannot reach and fails; CI has no `.env` and skips it. Today the workaround is the `-run 'TestFindMedian|TestCalculateIntervals|TestApplyRatings'` filter in CLAUDE.md. Fix: skip unless `TEST_DB_NAME` is set in the process env, checked before `.env` is loaded (the local `.env` sets `TEST_DB_NAME` too, so checking after the load would still run), so a plain run skips on any machine; `make test-calculator` sets it and still loads `.env` for `DB_USER` / `DB_PASSWORD`. Then drop the `-run` workaround and the DB_USER skip rule from CLAUDE.md (Tests, Deployment → CI).
