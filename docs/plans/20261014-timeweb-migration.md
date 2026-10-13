# Migrate native-ad-skip-api from Yandex Cloud to Timeweb Cloud (Novosibirsk)

Date: 2026-10-14. Follows `docs/research/20261013-yandex-cloud-outage-analysis.md` (why we leave) and `docs/research/20261014-hosting-selection.md` (why Timeweb Novosibirsk).

## Overview

Production is down since 2026-10-11: the only VM (`178.154.241.202`, YC zone `ru-central1-a`) is unreachable and the zone has no recovery ETA. This plan rebuilds the whole stack on a fresh Timeweb Cloud VM in Novosibirsk, restores data from the local dump `~/Web/dumps/outputfile-09-10-2026.sql`, repoints DNS, re-enables CI/CD, and closes the two long-standing operational gaps that turned an outage into a data-loss question: no off-host backups and the reverse proxy / TLS config living only on the dead host.

Success = `https://${API_HOST}/` answers `{"status":"ok"}` from a Russian mobile and a home ISP, the extension works without a release, markups/votes round-trip, the Go calculator runs every minute, a push to `main` deploys, and a nightly `pg_dump` lands off-host.

Accepted data loss: markups between 2026-10-09 23:22 (dump) and 2026-10-11 04:00 (zone down) — about 1.5 days. See Post-Completion for the "if zone a comes back" delta question.

## Context (from discovery)

**Facts established on 2026-10-14:**

| Item | Finding |
|---|---|
| Client addressing | Extension (`../native-ad-skip/.env.production`) uses `VUE_APP_API_URL=https://${API_HOST}` via `src/api/index.ts:92`. Domain-based → **no extension release needed**. Old-IP blocker from the outage doc is cleared. |
| DNS | `${API_HOST} A 178.154.241.202`, NS `ns1/ns2.reg.ru`. `.dev` is HSTS-preloaded → HTTPS is mandatory, plain HTTP will never work for the extension. |
| Reverse proxy / TLS | Not in the repo. Commit `b214edf "Nginx"` (2026-01-04) only changed the app port binding to `127.0.0.1:3022`, meaning an nginx on the old host terminated TLS (Let's Encrypt, presumably certbot) and proxied to `:3022`. Must be recreated and this time committed under `infrastructure/`. |
| Old host OS / PG | Dump header: `PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)` → Ubuntu 24.04, Postgres 16 installed on the host via apt (not Docker). |
| Dump | Full `pg_dump` (schema + data, 41 tables, 69.8k lines, 6.7 MB). All objects `OWNER TO postgres`. No `CREATE DATABASE` / `CREATE ROLE`. Contains `\restrict` / `\unrestrict` (pg_dump ≥ 16.10 feature) → **must be restored with psql ≥ 16.10**; local Homebrew psql 14.17 fails with `invalid command \restrict`. Row counts: markups 12 531, markup_time_intervals 12 527, videos 6 326, video_calculateds 6 324, votes 2 628, users 1 705, duration_logs 28; all `rt_*` / `yt_*` / `prv_events_*` / `prv_admin_decisions` tables are empty. Dump includes `CREATE TABLE`, so **do not run `scripts/sync-db.js` or boot the app before the restore** (the research note "sync-db then load dump" is wrong — the restore would fail on existing tables). |
| Compose stack | `docker-compose.yml`: `app` (Node + Go cron via supervisor, bound `127.0.0.1:3022`), `prometheus` (`127.0.0.1:9090`), `grafana` (`0.0.0.0:3024`), `swagger-ui` (not deployed). External docker network `main-network` must pre-exist. DB reached via public IP `178.154.241.202` + `extra_hosts database:` — the C2 workaround from `docs/plans/20260925-close-db-public-exposure.md`; fixed here instead of carried over. |
| Deploy | `.github/workflows/deploy.yml`: tar over SSH as `skipper-admin` to `/home/skipper-admin/tmp`, then `docker-compose -p native-ad-skip-api ... down && up --build -d app prometheus grafana`. Secrets: `SSH_PRIVATE_KEY_YC`, `HOST_IP_YC`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `NODE_APP_PORT`, `AUTH_TOKEN`, `GF_ADMIN_PASSWORD`. Uses legacy `docker-compose` v1 binary (Ubuntu 24.04 has only the `docker compose` v2 plugin). |
| Second deploy pipeline | `../native-ad-skip-grafana/.github/workflows/deploy.yml` still pushes a standalone Grafana to the hardcoded old IP. Superseded by `20260513-grafana-consolidation.md` (Grafana now lives in this repo's compose). Must be disabled, not migrated. |
| Lost with the host | Prometheus TSDB (30 d of metrics), Grafana volume (dashboards are provisioned from `grafana/dashboards`, so only ad-hoc edits are lost), nginx config + certs, any `.env` on the host. |
| Old DO droplet | `134.122.73.229` still up with a Postgres from before 2026-01-07. Nine months older than the dump — nothing to merge. Ignore. |

**Decisions taken in this plan (change them before Task 1 if you disagree):**

1. **Postgres on the host via apt (PG 16), not Timeweb managed DB, not in Docker.** Matches the dump version, keeps `psql`/`pg_dump` trivial, no extra monthly fee. The Docker→host path is fixed with `host-gateway` + `pg_hba` for the Docker subnets and `ufw`, so Postgres is never public.
2. **nginx + certbot on the host**, same as before, but the vhost file is committed to `infrastructure/nginx/` and copied into place by hand (one file, changes rarely). Caddy would be simpler but adds a second way of doing things for no gain.
3. **Grafana stays on `:3024` plain HTTP** as today, restricted by `ufw` to the admin's IP(s). Putting it behind nginx + TLS on a subdomain is a follow-up, not a migration blocker.
4. **Deploy workflow switches to `docker compose` v2** and generic secret names (`HOST_IP`, `SSH_PRIVATE_KEY`). Keeping v1 would mean installing an EOL binary on a fresh host.
5. **Backups: nightly `pg_dump` to Timeweb S3 + Timeweb VM auto-backups enabled.** Two independent mechanisms; the S3 one is the real off-host copy.
6. **No staging rehearsal.** Service is already down, so there is nothing to protect; the restore is tested on the new VM itself before DNS moves.

## Development Approach

- This is infrastructure work. "Tests" are the verification commands at the end of each task; every task ends with a concrete check and its expected output.
- Sequence matters: DB restore happens **before** the app's first boot (Task 4 before Task 6), DNS moves **before** certbot can issue a cert (Task 5), app deploy only after TLS works.
- Secrets never go into the repo or this file. New `DB_PASSWORD`, `AUTH_TOKEN`, `GF_ADMIN_PASSWORD` are generated on the host and stored in a password manager + GitHub secrets. Reuse of old values is allowed only for `AUTH_TOKEN` if Grafana links or bookmarks embed it.
- Mark checkboxes as you go; add ➕ for discovered tasks, ⚠️ for blockers.

## Testing Strategy

- Per-task curl / psql / docker checks listed inline.
- Final acceptance (Task 11): `make test-e2e` locally against the committed compose changes + the live HTTPS smoke test from two Russian vantage points (mobile data, home wired ISP) — datacenter vantage points (check-host.net) do not prove reachability through TSPU.

## What Goes Where

- **Implementation Steps**: everything you do on the Mac, in the Timeweb panel, on the new VM, at reg.ru, and in GitHub.
- **Post-Completion**: YC cleanup after Oct 31, optional delta recovery, Grafana hardening, cost check.

## Implementation Steps

### Task 1: Provision the VM in Timeweb Cloud

**Files:** none (Timeweb panel)

- [ ] Timeweb Cloud panel → Облачные серверы → Создать: location **Новосибирск**, OS **Ubuntu 24.04**, tariff **Cloud 50** (2 vCPU / 4 GB / 50 GB NVMe, ~3 840 ₽/mo); fallback per research: Beget SPb or RUVDS Novosibirsk if provisioning fails today
- [ ] add the Mac's public key (`~/.ssh/id_ed25519.pub`) as the server SSH key; disable password login in the panel if offered
- [ ] enable **Автобэкапы** for the server (daily, keep 7) — cheap insurance that covers nginx/certs/postgres config, not just data
- [ ] note the public IPv4 as `NEW_IP` (used everywhere below); skip IPv6 for now
- [ ] verify: `ssh root@NEW_IP 'lsb_release -ds; nproc; free -h; df -h /'` → Ubuntu 24.04, 2 CPU, ~4 GB, ~50 GB

### Task 2: Base host setup (user, firewall, Docker)

**Files:** none (host shell)

- [ ] `apt update && apt upgrade -y && apt install -y ufw git curl jq`
- [ ] create deploy user: `adduser --disabled-password skipper-admin && usermod -aG sudo,docker skipper-admin` (docker group after Docker install below); `mkdir -p /home/skipper-admin/tmp /home/skipper-admin/.ssh`; copy `authorized_keys` from root; `chown -R skipper-admin:skipper-admin /home/skipper-admin`
- [ ] on the Mac generate a dedicated CI key: `ssh-keygen -t ed25519 -f ~/.ssh/adskip-deploy -C deploy@native-ad-skip-api -N ''`; append the `.pub` to `/home/skipper-admin/.ssh/authorized_keys`
- [ ] sshd hardening: `PasswordAuthentication no`, `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config.d/99-hardening.conf`; `systemctl restart ssh`
- [ ] install Docker Engine + compose plugin from Docker's apt repo (Ubuntu's `docker.io` package is fine too but older): follow https://docs.docker.com/engine/install/ubuntu/ ; `docker compose version` → v2.x
- [ ] `docker network create main-network` (external network the compose file requires)
- [ ] `ufw default deny incoming; ufw default allow outgoing; ufw allow 22; ufw allow 80; ufw allow 443; ufw allow from <ADMIN_IP> to any port 3024; ufw enable` — Timeweb panel firewall: mirror the same rules (both layers, belt and braces)
- [ ] verify: `ssh skipper-admin@NEW_IP docker ps` works without sudo; `nmap -p 22,80,443,3022,3024,5432 NEW_IP` from the Mac shows only 22/80/443 open

### Task 3: PostgreSQL 16 on the host, reachable only from Docker and localhost

**Files:** none (host config); recipe is recorded in `docs/plans/20260925-close-db-public-exposure.md` Task 2 and gets closed by this task

- [ ] `apt install -y postgresql-16 postgresql-client-16`; confirm `psql --version` ≥ 16.10 (needed for `\restrict`); if Ubuntu's package is older, use the PGDG apt repo
- [ ] create role + DB: `sudo -u postgres psql -c "CREATE ROLE <DB_USER> LOGIN PASSWORD '<DB_PASSWORD>';" -c "CREATE DATABASE <DB_NAME> OWNER <DB_USER>;"` (pick `DB_NAME`/`DB_USER` equal to the old secrets if you remember them — keeps GitHub secrets unchanged)
- [ ] `/etc/postgresql/16/main/postgresql.conf`: `listen_addresses = '*'` (ufw blocks it from outside; `pg_hba` restricts who may connect)
- [ ] `/etc/postgresql/16/main/pg_hba.conf` append: `host <DB_NAME> <DB_USER> 172.16.0.0/12 scram-sha-256` (covers `docker0` 172.17/16 and `main-network` 172.18+/16)
- [ ] `ufw allow from 172.16.0.0/12 to any port 5432` (host-level service, so Docker's iptables bypass does not apply here)
- [ ] `systemctl restart postgresql`
- [ ] verify from a throwaway container on the external network: `docker run --rm --network main-network --add-host=host.docker.internal:host-gateway postgres:16 psql "postgresql://<DB_USER>:<DB_PASSWORD>@host.docker.internal:5432/<DB_NAME>" -c 'select 1'` → `1`
- [ ] verify from the Mac: `nc -zv -w3 NEW_IP 5432` → timeout (this is the C2 finding closed on day one)

### Task 4: Restore the dump

**Files:** `~/Web/dumps/outputfile-09-10-2026.sql` (Mac → VM)

- [ ] `scp ~/Web/dumps/outputfile-09-10-2026.sql skipper-admin@NEW_IP:/home/skipper-admin/tmp/`
- [ ] restore as superuser into the empty DB (the dump has `OWNER TO postgres` lines that a non-superuser cannot execute): `sudo -u postgres psql -v ON_ERROR_STOP=1 -d <DB_NAME> -f /home/skipper-admin/tmp/outputfile-09-10-2026.sql`
- [ ] hand ownership to the app role: `sudo -u postgres psql -d <DB_NAME> -c "REASSIGN OWNED BY postgres TO <DB_USER>;"`
- [ ] verify row counts match the dump: `psql ... -c "select (select count(*) from markups), (select count(*) from markup_time_intervals), (select count(*) from videos), (select count(*) from video_calculateds), (select count(*) from votes), (select count(*) from users)"` → `12531 | 12527 | 6326 | 6324 | 2628 | 1705`
- [ ] verify sequences were restored (dump includes `setval`): `select last_value from markups_id_seq` ≥ 12531
- [ ] verify `users.banned_at` column exists (it is in the dump; `db.js` bootstrap's `ADD COLUMN IF NOT EXISTS` would also handle it)
- [ ] `rm /home/skipper-admin/tmp/outputfile-09-10-2026.sql` (contains `prv_user_id`s; don't leave it in a world-readable tmp dir)

### Task 5: DNS at reg.ru + nginx + Let's Encrypt

**Files:**
- Create: `infrastructure/nginx/api.conf`
- Create: `infrastructure/nginx/README.md` (3 lines: where it goes, certbot command, reload)

- [ ] reg.ru → DNS zone `${DNS_ZONE}` → edit `A api` → `NEW_IP`; set TTL to 300 if the panel allows (current TTL is 3600 s; lower it so a rollback to another host is fast). Nothing to protect on the old IP, so do this now rather than at the end.
- [ ] `apt install -y nginx certbot python3-certbot-nginx`
- [ ] write `infrastructure/nginx/api.conf` in the repo: `server_name ${API_HOST};` `location / { proxy_pass http://127.0.0.1:3022; proxy_set_header Host $host; X-Real-IP / X-Forwarded-For / X-Forwarded-Proto; proxy_read_timeout 60s; }` plus `client_max_body_size 1m;` (events batches are small JSON). `server.js` already has `trust proxy = true`, so `X-Forwarded-For` is what the rating/ban logic and `/metrics` see.
- [ ] `scp` it to `/etc/nginx/sites-available/`, symlink into `sites-enabled`, remove `default`, `nginx -t && systemctl reload nginx`
- [ ] wait for `dig +short ${API_HOST} @ns1.reg.ru` → `NEW_IP`, then `certbot --nginx -d ${API_HOST} --non-interactive --agree-tos -m <email> --redirect`
- [ ] verify: `curl -sI https://${API_HOST}/` → `502` from nginx (app not up yet) with a valid LE cert; `systemctl list-timers | grep certbot` shows the renewal timer
- [ ] commit the nginx config + README to the repo (`infra: nginx vhost for api (Timeweb host)`)

### Task 6: Repo changes — compose, deploy workflow, docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `CLAUDE.md` (Deployment, Environment Variables, Grafana paragraph)
- Modify: `docs/plans/20260925-close-db-public-exposure.md` (mark Tasks 1–6 superseded by this plan)

- [ ] `docker-compose.yml` `app` and `grafana`: replace `extra_hosts: database:178.154.241.202` with `extra_hosts: - "host.docker.internal:host-gateway"`; `app` `DB_HOST=host.docker.internal`; `grafana` `DB_HOST=host.docker.internal` (Grafana's Postgres datasource reads `${DB_HOST}`, see `grafana/provisioning/datasources/datasources.yml`)
- [ ] `docker-compose.yml` `grafana` ports: keep `3024:3024` (ufw restricts it); optionally change to `127.0.0.1:3024:3024` later when it goes behind nginx (Post-Completion)
- [ ] remove `version: '3.8'` (compose v2 warns on it) — cosmetic, optional
- [ ] `.github/workflows/deploy.yml`: rename secrets `SSH_PRIVATE_KEY_YC`→`SSH_PRIVATE_KEY`, `HOST_IP_YC`→`HOST_IP`; `docker-compose` → `docker compose` (both `down` and `up`); drop the now-unneeded `docker ps --filter ancestor` block and the v1 ContainerConfig comment; rename the workflow/job titles from "YC" to "Timeweb"; keep `DB_HOST: database` export or drop it (compose no longer reads it — drop it to avoid confusion)
- [ ] `grep -rn "178.154.241.202" --exclude-dir=node_modules --exclude-dir=vendor .` → only `docs/` hits remain
- [ ] `CLAUDE.md`: Deployment section → Timeweb Cloud Novosibirsk, nginx on host terminates TLS for `${API_HOST}`, Postgres 16 on host reached via `host.docker.internal`; Environment Variables → `DB_HOST=host.docker.internal` in prod; Grafana paragraph → remove the "sibling repo holds the Grafana compose stack" sentence (stale since the consolidation plan) and note `ufw`-restricted `:3024`
- [ ] run `make test-e2e` locally — the e2e compose is independent of these edits, but it proves nothing else broke
- [ ] commit: `chore: point deploy and compose at Timeweb host, DB via host-gateway`

### Task 7: GitHub secrets + first deploy

**Files:** none (GitHub settings)

- [ ] repo Settings → Secrets: add `HOST_IP=NEW_IP`, `SSH_PRIVATE_KEY=<contents of ~/.ssh/adskip-deploy>`; set `DB_NAME`, `DB_USER`, `DB_PASSWORD` to the Task 3 values; `NODE_APP_PORT=3022`; `AUTH_TOKEN`, `GF_ADMIN_PASSWORD` (new or reused — see Development Approach); delete `*_YC` secrets
- [ ] push `main` (Task 5 + Task 6 commits) → Actions run; or trigger `workflow_dispatch`
- [ ] on the VM: `docker ps` → `native-ad-skip-api-app-1`, `-prometheus-1`, `-grafana-1` up; `docker logs native-ad-skip-api-app-1` shows `Tables schemas synced` and the listen line, no `Unable to connect to the database`
- [ ] verify Go cron: after 2 minutes `docker exec native-ad-skip-api-app-1 tail -5 /tmp/mycron.log` → clean runs for prv/rt/yt, no connection errors
- [ ] verify: `curl -s https://${API_HOST}/` → `{"status":"ok"}`; `curl -s "https://${API_HOST}/video-calculated?v=1&native_id=<known id from dump>"` returns segments
- [ ] verify Grafana: `http://NEW_IP:3024` from the admin IP, both datasources "Test" green, dashboards render with live data

### Task 8: Day-one reachability test from Russia

**Files:** none

- [ ] from a Russian phone on mobile data (not Wi-Fi): open `https://${API_HOST}/` in the browser → `{"status":"ok"}`
- [ ] from a home wired ISP in Russia: same curl
- [ ] load the video platform with the extension installed, play a video that has segments in the dump → skip works; check `docker logs` for the `GET /video-calculated` line and the `/metrics` counter `video_calculated_lookup_total{outcome="match"}` incrementing
- [ ] submit a test markup + vote through the extension (or curl per `api/doc/openapi.yaml`) → row appears, next cron tick updates `video_calculateds`
- [ ] ⚠️ if the phone test fails while the wired one passes: that is the mobile-whitelist problem from the research, not a config bug; no host fix exists — record it and move on

### Task 9: Off-host backups

**Files:**
- Create: `infrastructure/backup/pg-backup.sh`
- Create: `infrastructure/backup/README.md`

- [ ] Timeweb panel → S3 хранилище → create bucket `adskip-backups` (smallest tier), create access key; `apt install -y s3cmd` (or `awscli`), configure with Timeweb's endpoint `https://s3.twcstorage.ru` (check the panel for the exact endpoint/region)
- [ ] `infrastructure/backup/pg-backup.sh`: `pg_dump -U <DB_USER> <DB_NAME> | gzip > /var/backups/pg/<DB_NAME>-$(date +%F).sql.gz`, upload to S3, delete local files older than 3 days; S3 lifecycle rule expires objects after 30 days
- [ ] install to `/usr/local/bin`, credentials in `/root/.s3cfg` (mode 600), root cron `15 03 * * *` (00:15 Novosibirsk time ≈ low traffic), log to `/var/log/pg-backup.log`
- [ ] run it once by hand; verify `s3cmd ls s3://adskip-backups/` shows today's file and `gunzip -c <file> | head -20` is a valid dump
- [ ] restore drill: `createdb restore_test && gunzip -c <file> | sudo -u postgres psql -v ON_ERROR_STOP=1 -d restore_test` → row counts match prod; `dropdb restore_test`
- [ ] commit script + README (`infra: nightly pg_dump to Timeweb S3`)

### Task 10: Disable the stale Grafana pipeline and tidy the old infra references

**Files:**
- Modify: `../native-ad-skip-grafana/.github/workflows/deploy.yml` (delete) or archive the repo
- Modify: `docs/research/20261013-yandex-cloud-outage-analysis.md`, `docs/research/20261014-hosting-selection.md` (one-line "migrated on <date>, see this plan" note at the top)

- [ ] `native-ad-skip-grafana`: delete the deploy workflow and add a README line "superseded by `native-ad-skip-api/docker-compose.yml` (grafana service)"; or archive the GitHub repo
- [ ] add the status line to both research docs
- [ ] update project memory (`project_yc_outage_2026-10.md`, `project_hosting_selection_2026-10.md`) → migration done, new IP, backup bucket name

### Task 11: Verify acceptance criteria

- [ ] `https://${API_HOST}/` reachable from RU mobile + RU wired (Task 8 evidence)
- [ ] markup → calculate → video-calculated → vote round-trip on prod
- [ ] `git push` to `main` redeploys without manual steps (push a trivial commit and watch Actions)
- [ ] `nc -zv -w3 NEW_IP 5432` and `:3022` and `:9090` from outside → closed; `:3024` closed from a non-admin IP
- [ ] yesterday's backup object exists in S3; restore drill passed
- [ ] `make test-e2e` green on the committed compose/workflow changes

### Task 12: [Final] Update documentation

- [ ] `CLAUDE.md` reflects Timeweb host, nginx/TLS, `host.docker.internal`, backups (done in Task 6/9 — re-read and confirm)
- [ ] `README.md` is empty; add a 10-line "Ops" section pointing at `infrastructure/` and this plan (optional)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Yandex Cloud cleanup**
- Services are free until 2026-10-31. Keep the VM/disk until then in case zone `a` returns; if it does, `pg_dump` the old DB and compare `max(id)`/`max("createdAt")` on `markups`, `markup_time_intervals`, `votes`, `users` against the 2026-10-09 dump. Merging the delta is non-trivial: the new host's sequences continue from the restored values, so ids of lost rows collide with new rows. Expect to accept the ~1.5-day loss unless the delta is large.
- Before 2026-10-31: delete the YC VM, disk, static IP, security group; close the billing account or leave it empty.

**Grafana hardening (follow-up, not blocking)**
- Move `:3024` behind nginx with TLS on `grafana.${DNS_ZONE}` (or a path), bind the container to `127.0.0.1`, drop the ufw admin-IP rule.

**C2 plan**
- `docs/plans/20260925-close-db-public-exposure.md` is effectively closed by Task 3 (Postgres never exposed on the new host). Mark it completed with a pointer here; its optional Task 7 (TLS to Postgres) stays optional.

**Cost / capacity watch**
- Cloud 50 at ~3 840 ₽/mo plus S3 and auto-backups. Check the first invoice; downgrade to Cloud 30 only if Prometheus+Grafana are moved off-box.

**Exit route**
- Timeweb's Almaty location is in the same panel; a snapshot → new server there plus a DNS change is the DR path if RF hosting becomes untenable (see hosting-selection research for the 152-FZ caveats).
