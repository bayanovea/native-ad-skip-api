---
worth: soon
where: the local restored dump (localhost:5433/skipper), scripts/sync-db.js, lib/schema.js renameLegacyObjects
added: 2026-11-02
---
# The local dump still has the pre-2026-10-29 names

The local dump was restored before the prod rename, so its tables, indexes and columns carry the old prefix. `scripts/sync-db.js` without `LEGACY_PRV` fails (`column "prv_user_id" does not exist` on the users index), so a new table (e.g. `prv_review_audits`) cannot be created there and dashboard SQL is checked only through temporary views in a rolled-back transaction. Fix, either: pull a fresh dump (`make pull-dump`, prod is renamed) and restore it; or run `sync-db.js` once with `LEGACY_PRV` set to the old prefix, which runs the same idempotent rename as the prod boot (`test/legacy-rename.test.js`). The fresh dump also replaces the stale review tables of 2026-10-14.
