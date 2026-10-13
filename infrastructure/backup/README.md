# Postgres backups

`pg-backup.sh` dumps the prod DB nightly (plain SQL, gzip), uploads it to the Timeweb S3 bucket `adskip-backups`, and keeps the last 3 days locally in `/var/backups/pg`. The bucket's lifecycle rule expires objects after 30 days. Timeweb VM auto-backups (daily, keep 7) are the second, independent layer.

## Setup (once, as root on the prod host)

```bash
apt install -y s3cmd
s3cmd --configure        # access key from the Timeweb panel, endpoint s3.twcstorage.ru (check the panel)
chmod 600 /root/.s3cfg
s3cmd expire s3://adskip-backups --expiry-days=30   # or set the lifecycle rule in the panel

install -m 755 pg-backup.sh /usr/local/bin/pg-backup.sh
crontab -e
# 15 0 * * * DB_NAME=<DB_NAME> /usr/local/bin/pg-backup.sh >> /var/log/pg-backup.log 2>&1
```

The schedule assumes the host clock is UTC (`timedatectl` to check): 00:15 UTC = 03:15 Moscow, the low-traffic window for a Russian audience.

## Check

```bash
DB_NAME=<DB_NAME> /usr/local/bin/pg-backup.sh   # run once by hand
s3cmd ls s3://adskip-backups/
tail /var/log/pg-backup.log
```

## Restore drill

```bash
s3cmd get s3://adskip-backups/<DB_NAME>-<date>.sql.gz /tmp/
sudo -u postgres createdb restore_test
gunzip -c /tmp/<DB_NAME>-<date>.sql.gz | sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d restore_test
sudo -u postgres psql -d restore_test -c "select (select count(*) from markups), (select count(*) from votes), (select count(*) from users)"
sudo -u postgres dropdb restore_test && rm /tmp/<DB_NAME>-<date>.sql.gz
```

Restoring prod for real: stop the app first (`docker compose -p native-ad-skip-api stop app`), restore into an empty DB owned by the app role, then start it — the app's `sequelize.sync()` must not run before the restore (the dump has `CREATE TABLE`).
