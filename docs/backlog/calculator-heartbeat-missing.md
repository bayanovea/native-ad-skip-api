---
worth: yes
where: calculator/calculate.go:36
added: 2026-10-16
---
# no signal when the calculator stops running or keeps failing

Since 2026-10-17 the cron lines (`crontab:1-3`) send the calculator's output to `/proc/1/fd/1`, so it lands in `docker logs` (before, it went to `/tmp/mycron.log` inside the container and was lost on every deploy). Still nothing watches it: if the calculator starts failing (a failing video is logged as `Calculate video failed: …` and the run exits 1) or stops running at all (cron dead, binary panics on connect), the API keeps serving stale segments and nobody notices until someone reads the logs.

Fix: a heartbeat (last successful run per provider, e.g. a row the binary updates at the end of `Run`, or a file Node reads) exposed on `/metrics`, and a Grafana alert on "no successful run in 10 min".

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
