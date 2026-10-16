---
worth: yes
where: crontab:1
added: 2026-10-16
---
# calculator output goes to /tmp inside the container

All three cron lines append to `/tmp/mycron.log` in the app container: not in `docker logs`, not rotated, gone on every deploy (the container is recreated). If the calculator starts failing (see [[calculator-recalc-not-atomic]]) the API keeps serving stale segments and nothing shows it.

Cheapest fix: redirect to `/proc/1/fd/1` so it lands in `docker logs`. Better: a heartbeat (last successful run per provider) exposed on `/metrics` and a Grafana alert on "no run in 10 min".

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
