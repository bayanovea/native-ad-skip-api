---
worth: yes
where: infrastructure/backup/pg-backup.sh:1
added: 2026-10-15
---
# nightly pg_dump to Timeweb S3 not installed on prod

Task 9 of `docs/plans/completed/20261014-timeweb-migration.md`, deferred when the rest of the migration closed. Script and
restore drill are in the repo (`infrastructure/backup/`, rehearsed in `postgres:16` with `s3cmd` stubbed); nothing is
installed on `${HOST_IP}` yet. Prod data currently lives only on the VM plus Timeweb auto-backups (same provider,
daily, keep 7) — the single-host situation that made the Yandex Cloud outage a data-loss question.

Interim: `make pull-dump` (`scripts/pull-prod-dump.sh`) pulls a gzipped dump to `~/Web/dumps/native-ad-skip-prod/` on the
owner's Mac; a SessionStart hook in the owner's `.claude/settings.local.json` nags when the newest one is over 7 days
old. Retire both once S3 runs.

To finish (setup + check commands in `infrastructure/backup/README.md`):
- Timeweb panel → S3: private bucket `adskip-backups` (if the name is taken, set `BUCKET=` in the cron line),
  access key, note endpoint/region (expected `s3.twcstorage.ru`, `ru-1`); 30-day lifecycle rule.
- Host as root: `apt install -y s3cmd`, `s3cmd --configure` (owner types the keys), `chmod 600 /root/.s3cfg`,
  install the script to `/usr/local/bin`, root cron `15 0 * * * DB_NAME=adskip /usr/local/bin/pg-backup.sh >>
  /var/log/pg-backup.log 2>&1` (host clock is UTC → 03:15 MSK).
- Run once by hand, `s3cmd ls`, restore drill into `restore_test`, compare row counts, drop it.
- Then remove the interim hook and decide whether `make pull-dump` stays as a convenience.
