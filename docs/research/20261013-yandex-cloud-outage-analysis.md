# Yandex Cloud outage (October 2026) — impact on native-ad-skip-api and migration decision

> **Status 2026-10-15: migrated.** Prod runs on Timeweb Cloud **Almaty** (`ala-1`, `${HOST_IP}`) — Novosibirsk had no free capacity that day, so the documented exit location was used. DNS, TLS, first deploy and RU mobile/wired reachability verified; nightly S3 backups still open (`docs/backlog/offhost-pg-backup-s3.md`). See `docs/plans/completed/20261014-timeweb-migration.md`.

Date: 2026-10-13. Status of our VM: `178.154.241.202`, zone `ru-central1-a`, console shows RUNNING, serial console does not load, SSH/HTTP unreachable from every external vantage point (check-host.net report `50b3c5c8k1ce`: Moscow, Kazakhstan, Romania, Germany, US all time out on :22 and :3022).

## TL;DR

- Zone `ru-central1-a` (Vladimir datacenter) is physically down after a drone strike and fire on 2026-10-11 04:00 MSK. The "RUNNING" status in the console is stale control-plane state.
- Yandex gives no ETA. All signals (see below) point to weeks at best, more likely months.
- **Decision: migrate to another provider now.** Local dump `~/Web/dumps/outputfile-09-10-2026.sql` (2026-10-09) caps data loss at ~2 days of markups.
- Re-running the GitHub Actions deploy does not help: it only SSHes into the VM and runs docker-compose. It fails at the transfer step while :22 is unreachable, and the first thing it does on success is `docker-compose down`.

## Zone → datacenter mapping

| Zone | Datacenter | State as of 2026-10-13 |
|---|---|---|
| ru-central1-a | Vladimir (40 MW, ~2,900 racks) | Fire after strike 2026-10-11, "work completely stopped" |
| ru-central1-b | Sasovo, Ryazan obl. (12 MW) | Fire after strike 2026-10-08, down 5+ days, no recovery progress |
| ru-central1-d | Kaluga (63 MW, ~3,800 racks) | Several modules destroyed 2026-10-09, zone still serving |
| ru-central1-e | Moscow region | Running, capacity constrained, quotas frozen |

## Timeline (status.yandex.cloud incidents 2092 and 2136)

- 2026-10-08 01:31 MSK — power failure in `ru-central1-b`; 15:19 MSK confirmed fire from drone strike at Sasovo, datacenter fully stopped.
- 2026-10-09 — second strike, Kaluga; Yandex announces priority onboarding deals with Selectel, K2 Cloud, prv Cloud (codeword "CloudBro").
- 2026-10-10 — fully manual quota management for compute and disks.
- 2026-10-11 04:12 MSK — strike on Vladimir, `ru-central1-a` fully stopped. Platform declared in emergency mode ("remaining configuration considered unstable, use any alternative DR plans"). Quota issuance suspended.
- 2026-10-12 — FAQ published at https://yandex.cloud/ru/recommendations: "cannot name recovery timelines"; instructs clients to delete hosts in damaged zones; no way to snapshot or copy disks located in an unavailable zone.
- 2026-10-13 12:05 MSK — all Yandex Cloud services free for existing clients from Oct 8 through Oct 31. Still "limited mode", no ETA.

## Signals used to estimate the timeline

1. **Sasovo as leading indicator.** Same incident type three days earlier; in 5 days the only "recovery" for zone b was allowing clients to delete hosts from it.
2. **Yandex's own actions.** Partner deals to move clients out, "use alternative platforms" in every update since Oct 11, free billing until Oct 31, frozen quotas. None of this is consistent with a restoration measured in days.
3. **Official FAQ** explicitly states no timeline can be given and that data on disks in unavailable zones cannot currently be accessed or exported.
4. **Press / industry estimates.** Kommersant sources: "several months", equipment lead times up to 6 months. Habr analysis: weeks for power/cooling, months for server modules, years for supercomputers. The "not before 2028" claim on LiveJournal is unsourced; ignored.
5. **Not an allocation decision.** Status log names fire and infrastructure damage for both zones. The capacity shortage is in the surviving zones d/e, not a reason to keep a/b dark.

Outlook: zone a will not be back in October. Weeks is the optimistic case if storage and power halls survived; months if servers must be replaced. Whether the VM's disk survived is unknowable until the zone is up.

## Migration notes

- Deploy workflow `.github/workflows/deploy.yml` needs only new `HOST_IP_YC` and `SSH_PRIVATE_KEY_YC` secrets (and user `skipper-admin` + `/home/skipper-admin/tmp` on the new host).
- Stack: single `docker-compose.yml` (app, prometheus, grafana), Postgres on the host, app reaches DB via `DB_HOST=<public ip>` + `extra_hosts` (see `docs/plans/20260925-close-db-public-exposure.md`; fix this on the new host instead of carrying the workaround over).
- Data: restore schema with `scripts/sync-db.js`, then load `outputfile-09-10-2026.sql`.
- **Unverified blocker:** how the browser extension addresses the API. If it hardcodes `178.154.241.202` instead of a domain, the IP cannot follow us and a client release is required.
- Provider decision (2026-10-14): **Timeweb Cloud, Novosibirsk** (landed in Almaty on 2026-10-15, no Novosibirsk capacity) — see `20261014-hosting-selection.md`. Earlier note: not Yandex zones d/e (quotas frozen, Kaluga damaged, Yandex itself recommends leaving). Any Russian provider meets the traffic-locality requirement that drove the DO → YC move. Selectel / prv Cloud have priority onboarding this week; Timeweb / Beget are cheaper for a pet project.
- After the move: set up off-host `pg_dump` on a schedule. The absence of one is what made this decision a data-loss question in the first place.

## Sources

- https://status.yandex.cloud/ru/incidents/2136 (JSON: https://status.yandex.cloud/api/incidents)
- https://yandex.cloud/ru/recommendations
- https://t.me/s/yandexcloudalerts
- https://habr.com/ru/articles/1093198/
- https://www.securitylab.ru/news/578589.php
- https://www.currenttime.tv/a/yandeks-data-tsentry-ataki-vosstanovlenie/33874995.html
- https://www.fontanka.ru/2026/10/11/76693363/
- https://www.ixbt.com/news/2026/10/13/oblako-besplatno-yandex-cloud-ne-budet-brat-dengi-s-klientov-do-noiabria.html
- https://vc.ru/id6143442/3189615-problemy-yandex-cloud-otklyucheniye-zon-dostupnosti
- https://check-host.net/check-report/50b3c5c8k1ce
