---
worth: later
where: calculator/integration_test.go (connectTestDB), the repo's local .env
added: 2026-11-02
---
# `go test ./calculator` fails locally

`connectTestDB` loads `.env` / `../.env` when they exist, and the local `.env` sets `DB_USER` and `DB_HOST=host.docker.internal`, so plain `go test ./calculator` on the Mac runs `TestIntegration` against a host it cannot reach and fails; CI has no `.env` and skips it. Today the workaround is the `-run 'TestFindMedian|TestCalculateIntervals|TestApplyRatings'` filter in CLAUDE.md. Fix: load the env file only under `make test-calculator` (it sets `TEST_DB_NAME`), i.e. skip unless `TEST_DB_NAME` is set, so a plain run skips on any machine.
