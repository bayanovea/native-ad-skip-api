# Migrate native-ad-skip-api from Yandex Cloud to Timeweb Cloud (Novosibirsk)

Date: 2026-10-14. Follows `docs/research/20261013-yandex-cloud-outage-analysis.md` (why we leave) and `docs/research/20261014-hosting-selection.md` (why Timeweb Novosibirsk).

> **Status 2026-10-15: COMPLETED.** Prod live on the new host; Tasks 1–8, 10, 12 done. Task 9 (S3 backups) and the S3/e2e acceptance items moved to `docs/backlog/` (`offhost-pg-backup-s3.md`, `e2e-moderation-vote-404.md`). Landing site `${LANDING_HOST}` is a separate follow-up. ⚠️ The VM landed in **Timeweb Almaty (`ala-1`), not Novosibirsk**: Novosibirsk had no free capacity (the panel only offered a preorder queue), so the exit-route location was used up front. `NEW_IP` = **`${HOST_IP}`**, hostname `api`. A plain-HTTP probe from Russian networks (mobile + home wired, no VPN) reached it; the full HTTPS check is still Task 8. Wherever this plan says Novosibirsk, read Almaty.

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

- [x] Timeweb Cloud panel → Облачные серверы → Создать: location **Новосибирск**, OS **Ubuntu 24.04**, tariff **Cloud 50** (2 vCPU / 4 GB / 50 GB NVMe, ~3 840 ₽/mo); fallback per research: Beget SPb or RUVDS Novosibirsk if provisioning fails today. ⚠️ Done 2026-10-15 in **Almaty** (Novosibirsk = preorder only): fixed preset 2×3.3 GHz / 4 GB / 50 GB NVMe, public IPv4 200 ₽, no IPv6, no private network, project ADSKIP
- [x] add the Mac's public key (`~/.ssh/id_ed25519.pub`) as the server SSH key; disable password login in the panel if offered (the panel switch was locked; password login disabled in sshd in Task 2 instead)
- [x] enable **Автобэкапы** for the server (daily, keep 7) — cheap insurance that covers nginx/certs/postgres config, not just data (enabled at creation, 300 ₽/mo)
- [x] note the public IPv4 as `NEW_IP` (used everywhere below); skip IPv6 for now → `${HOST_IP}`
- [x] verify: `ssh root@NEW_IP 'lsb_release -ds; nproc; free -h; df -h /'` → Ubuntu 24.04, 2 CPU, ~4 GB, ~50 GB
- [x] ➕ reachability probe before any setup: `python3 -m http.server 80` in an empty dir, opened from a Russian phone on mobile data and a home wired ISP (VPN off) → `ok`. Running it over an ssh session that drops (e.g. toggling a VPN on the Mac) kills the server; use `ssh -t` so Ctrl+C reaches the remote process

### Task 2: Base host setup (user, firewall, Docker)

**Files:** none (host shell)

- [x] `apt update && apt upgrade -y && apt install -y ufw git curl jq`
- [x] create deploy user: `adduser --disabled-password skipper-admin && usermod -aG sudo,docker skipper-admin` (docker group after Docker install below); `mkdir -p /home/skipper-admin/tmp /home/skipper-admin/.ssh`; copy `authorized_keys` from root; `chown -R skipper-admin:skipper-admin /home/skipper-admin`. ➕ Added to `docker` only, not `sudo`: the user has no password, so sudo would never work; host admin is done as root
- [x] on the Mac generate a dedicated CI key: `ssh-keygen -t ed25519 -f ~/.ssh/adskip-deploy -C deploy@native-ad-skip-api -N ''`; append the `.pub` to `/home/skipper-admin/.ssh/authorized_keys`. Verified: `ssh -i ~/.ssh/adskip-deploy -o IdentitiesOnly=yes skipper-admin@NEW_IP 'echo ok'` → `ok`
- [x] sshd hardening: `PasswordAuthentication no`, `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config.d/99-hardening.conf`; `systemctl restart ssh`. ➕ File is **`00-hardening.conf`**, not `99-`: Ubuntu cloud images ship `50-cloud-init.conf` with `PasswordAuthentication yes` and sshd keeps the first value it reads. Verified with `sshd -T` and `ssh -o PubkeyAuthentication=no root@NEW_IP` → `Permission denied (publickey)`
- [x] install Docker Engine + compose plugin from Docker's apt repo (Ubuntu's `docker.io` package is fine too but older): follow https://docs.docker.com/engine/install/ubuntu/ ; `docker compose version` → v2.x. ➕ Used Ubuntu packages instead: `apt install -y docker.io docker-compose-v2 docker-buildx` (Docker 29.1, Compose 2.40.3, buildx 0.30.1). `docker-buildx` is required — recent Compose refuses `build` without it
- [x] `docker network create main-network` (external network the compose file requires)
- [x] `ufw default deny incoming; ufw default allow outgoing; ufw allow 22; ufw allow 80; ufw allow 443; ufw enable`. ➕ Also `ufw allow 10050/tcp` for the Timeweb Zabbix agent (panel CPU/RAM graphs); the agent's `Server=` only admits `92.53.116.12,.111,.119`
- [x] ⚠️ Timeweb panel → Firewall: inbound allow 22, 80, 443 from anywhere, **3024 only from `<ADMIN_IP>`**, deny the rest; attach to the server. This layer is the one that actually protects Grafana: Docker publishes `3024:3024` through its own iptables DNAT rules, which bypass `ufw` entirely, so a `ufw allow from <ADMIN_IP> to any port 3024` rule would be a no-op. If the panel firewall is unavailable, bind Grafana to `127.0.0.1:3024` and use `ssh -L 3024:localhost:3024` instead. ➕ Done as an allow-list group with inbound TCP 22, 80, 443, 10050 for all addresses; **3024 not opened at all** (admin IP changes with VPN) → Grafana via `ssh -L 3024:localhost:3024 root@NEW_IP`. Outbound list left empty = unrestricted (checked: `apt update` and `curl https://github.com` → 200) ➕ 2026-10-15 (Task 7): owner chose plain `http://NEW_IP:3024` over the tunnel → inbound TCP 3024 from all addresses added to the panel group; Grafana is protected by its login only
- [x] verify: `ssh skipper-admin@NEW_IP docker ps` works without sudo; `nmap -Pn -p 22,80,443,3022,3024,5432 NEW_IP` from the Mac shows only 22/80/443 open (re-check 3024 from a non-admin IP after Task 7, when Grafana is actually listening). Checked with `nc -zv -G 3`: only 22 open. 3022/3024 still need the re-check in Task 7 — nothing listens there yet

### Task 3: PostgreSQL 16 on the host, reachable only from Docker and localhost

**Files:** none (host config); recipe is recorded in `docs/plans/20260925-close-db-public-exposure.md` Task 2 and gets closed by this task

- [x] `apt install -y postgresql-16 postgresql-client-16`; confirm `psql --version` ≥ 16.10 (needed for `\restrict`); if Ubuntu's package is older, use the PGDG apt repo → `16.15-0ubuntu0.24.04.1`, same as the old host
- [x] create role + DB: `sudo -u postgres psql -c "CREATE ROLE <DB_USER> LOGIN PASSWORD '<DB_PASSWORD>';" -c "CREATE DATABASE <DB_NAME> OWNER <DB_USER>;"` (pick `DB_NAME`/`DB_USER` equal to the old secrets if you remember them — keeps GitHub secrets unchanged). ➕ Old values unknown (GitHub secrets are write-only) → **`DB_NAME=adskip`, `DB_USER=adskip`**, password from `openssl rand -hex 24`, kept in the password manager. Task 7 must set all three secrets
- [x] `/etc/postgresql/16/main/postgresql.conf`: `listen_addresses = '*'` (ufw blocks it from outside; `pg_hba` restricts who may connect)
- [x] `/etc/postgresql/16/main/pg_hba.conf` append: `host <DB_NAME> <DB_USER> 172.16.0.0/12 scram-sha-256` (covers `docker0` 172.17/16 and `main-network` 172.18+/16)
- [x] `ufw allow from 172.16.0.0/12 to any port 5432` (host-level service, so Docker's iptables bypass does not apply here)
- [x] `systemctl restart postgresql`
- [x] verify from a throwaway container on the external network: `docker run --rm --network main-network --add-host=host.docker.internal:host-gateway postgres:16 psql "postgresql://<DB_USER>:<DB_PASSWORD>@host.docker.internal:5432/<DB_NAME>" -c 'select 1'` → `1`
- [x] verify from the Mac: `nc -zv -w3 NEW_IP 5432` → timeout (this is the C2 finding closed on day one)

### Task 4: Restore the dump

**Files:** `~/Web/dumps/outputfile-09-10-2026.sql` (Mac → VM)

- [x] `scp ~/Web/dumps/outputfile-09-10-2026.sql skipper-admin@NEW_IP:/home/skipper-admin/tmp/`
- [x] ➕ restore **as the app role** with the 85 `ALTER … OWNER TO postgres;` lines stripped (41 tables, 41 sequences, 3 enum types — checked against the dump; it has no extensions, grants or functions), so every object is created owned by `<DB_USER>`: `sed -E '/^ALTER (TABLE|SEQUENCE|TYPE) .* OWNER TO postgres;$/d' /home/skipper-admin/tmp/outputfile-09-10-2026.sql | psql -v ON_ERROR_STOP=1 -q "postgresql://<DB_USER>:<DB_PASSWORD>@127.0.0.1:5432/<DB_NAME>" > /dev/null` (stdout is just ~40 `setval` results). Rehearsed 2026-10-14 in `postgres:16` (16.15) against the real dump: row counts match, all 41 tables owned by the app role, `markups_id_seq` = 12901, `users.banned_at` present. The original "restore as postgres, then `REASSIGN OWNED BY postgres TO <DB_USER>`" does not work: Postgres refuses to reassign objects of the bootstrap superuser (`cannot reassign ownership of objects owned by role postgres because they are required by the database system`). The `public` schema is writable by `<DB_USER>` because PG 15+ grants it to the database owner.
- [x] verify ownership: `psql … -c "select count(*) from pg_tables where schemaname='public' and tableowner <> '<DB_USER>'"` → `0`
- [x] verify row counts match the dump: `psql ... -c "select (select count(*) from markups), (select count(*) from markup_time_intervals), (select count(*) from videos), (select count(*) from video_calculateds), (select count(*) from votes), (select count(*) from users)"` → `12531 | 12527 | 6326 | 6324 | 2628 | 1705`
- [x] verify sequences were restored (dump includes `setval`): `select last_value from markups_id_seq` ≥ 12531 → `12901`
- [x] verify `users.banned_at` column exists (it is in the dump; `db.js` bootstrap's `ADD COLUMN IF NOT EXISTS` would also handle it)
- [x] `rm /home/skipper-admin/tmp/outputfile-09-10-2026.sql` (contains `prv_user_id`s; don't leave it in a world-readable tmp dir) (confirmed 2026-10-15: tmp dir empty)

### Task 5: DNS at reg.ru + nginx + Let's Encrypt

**Files:**
- Create: `infrastructure/nginx/api.conf`
- Create: `infrastructure/nginx/README.md` (3 lines: where it goes, certbot command, reload)

- [x] reg.ru → DNS zone `${DNS_ZONE}` → edit `A api` → `NEW_IP`; ➕ reg.ru has no per-record TTL; zone TTL was **1d (86400 s)**, not 3600 — set zone TTL to `1h` (panel minimum) and negative-cache Minimum to `1h`, so a future rollback is fast. Resolvers that already cached the old IP keep it up to 24 h regardless. Nothing to protect on the old IP, so do this now rather than at the end.. Done 2026-10-15: all five `*adskip*` A records (incl. `test-`, `www.` and the landing `adskip`/`www.adskip`) → `NEW_IP`; both reg.ru NS served it by 17:51 MSK, SOA TTL/minimum 3600. The landing site is out of scope for this plan (handled separately) — until it has its own vhost, `${LANDING_HOST}` hits the API vhost and shows a cert mismatch
- [x] `apt install -y nginx certbot` (no `python3-certbot-nginx`: certbot runs with the webroot authenticator so it never rewrites the vhost, and the committed file stays identical to the host copy) → nginx 1.24.0-2ubuntu7.18, certbot 2.9.0, `certbot.timer` active
- [x] write `infrastructure/nginx/api.conf` in the repo: `:80` serves `/.well-known/acme-challenge/` from `/var/www/html` and 301s everything else; `:443` with the LE cert paths, TLS 1.2/1.3, `client_max_body_size 1m`, `proxy_pass http://127.0.0.1:3022` with `Host` / `X-Real-IP` / `X-Forwarded-Proto`. `X-Forwarded-For` is set to `$remote_addr` (overwrite, not append) because `trust proxy = true` would otherwise make a client-supplied header `req.ip`; the app doesn't read client IPs today, so this is just hygiene. Validated with `nginx -t` on `nginx:1.24` (Ubuntu 24.04's version — hence `listen 443 ssl http2`, not `http2 on`).
- [x] wait for `dig +short ${API_HOST} @ns1.reg.ru` → `NEW_IP`; with the stock `default` site still enabled (it serves `/var/www/html` on `:80`): `certbot certonly --webroot -w /var/www/html -d ${API_HOST} --non-interactive --agree-tos -m <email> --deploy-hook "systemctl reload nginx"` → cert issued 2026-10-15 by LE `YE2`, expires 2027-01-13; renewal conf: `authenticator = webroot`, `renew_hook = systemctl reload nginx`
- [x] `scp` the vhost to `/etc/nginx/sites-available/`, symlink into `sites-enabled`, remove `default`, `nginx -t && systemctl reload nginx` (steps also in `infrastructure/nginx/README.md`) → host copy is byte-identical to the repo file; only `api.conf` in `sites-enabled`
- [x] verify: `curl -sI https://${API_HOST}/` → `502` from nginx (app not up yet) with a valid LE cert; `curl -sI http://${API_HOST}/` → `301`; `systemctl list-timers | grep certbot` shows the renewal timer; `certbot renew --dry-run` passes. ➕ 2026-10-15: HTTPS `502` with `ssl_verify=0`; HTTP `/foo` → `301` to `https://…/foo`; `/.well-known/acme-challenge/x` on :80 → `404` from webroot (not redirected), `certbot.timer` active; `certbot renew --dry-run` → all simulated renewals succeeded
- [x] commit the nginx config + README to the repo (`infra: nginx vhost for api (Timeweb host)`)

### Task 6: Repo changes — compose, deploy workflow, docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `CLAUDE.md` (Deployment, Environment Variables, Grafana paragraph)
- Modify: `docs/plans/20260925-close-db-public-exposure.md` (mark Tasks 1–6 superseded by this plan)

- [x] `docker-compose.yml` `app` and `grafana`: replace `extra_hosts: database:178.154.241.202` with `extra_hosts: - "host.docker.internal:host-gateway"`; `app` `DB_HOST=host.docker.internal`; `grafana` `DB_HOST=host.docker.internal` (Grafana's Postgres datasource reads `${DB_HOST}`, see `grafana/provisioning/datasources/datasources.yml`)
- [x] `docker-compose.yml` `grafana` ports: keep `3024:3024` (ufw restricts it); optionally change to `127.0.0.1:3024:3024` later when it goes behind nginx (Post-Completion)
- [x] remove `version: '3.8'` (compose v2 warns on it) — cosmetic, optional
- [x] ➕ `app`: add `restart: unless-stopped` (prometheus/grafana had it, app didn't — a host reboot or auto-backup restore left the API down until the next deploy)
- [x] `.github/workflows/deploy.yml`: rename secrets `SSH_PRIVATE_KEY_YC`→`SSH_PRIVATE_KEY`, `HOST_IP_YC`→`HOST_IP`; `docker-compose` → `docker compose` (both `down` and `up`); drop the now-unneeded `docker ps --filter ancestor` block and the v1 ContainerConfig comment; rename the workflow/job titles from "YC" to "Timeweb"; keep `DB_HOST: database` export or drop it (compose no longer reads it — drop it to avoid confusion). ➕ Also bumped `actions/checkout@v2` → `@v4`, wrote the key to `~/.ssh/id_ed25519`, dropped the no-op `echo "Host *\n…"` line; `down` no longer swallows errors (it was only there for the v1 ContainerConfig bug)
- [x] `grep -rn "178.154.241.202" --exclude-dir=node_modules --exclude-dir=vendor .` → only `docs/` hits remain
- [x] `CLAUDE.md`: Deployment section → Timeweb Cloud Novosibirsk, nginx on host terminates TLS for `${API_HOST}`, Postgres 16 on host reached via `host.docker.internal`; Environment Variables → `DB_HOST=host.docker.internal` in prod; Grafana paragraph → remove the "sibling repo holds the Grafana compose stack" sentence (stale since the consolidation plan) and note `ufw`-restricted `:3024`
- [x] run `make test-e2e` locally — the e2e compose is independent of these edits, but it proves nothing else broke. ⚠️ 2026-10-14: 82/85 pass; 3 moderation tests fail (`users[] sorted by score desc…`, `re-surface after enough new dislikes…`, `?show=all reveals approved user…`) with `POST /vote failed: 404`. Same 3 fail on a clean worktree of HEAD, so pre-existing and unrelated to the migration; investigate separately (Task 11's "e2e green" criterion depends on it)
- [x] commit: `chore: point deploy and compose at Timeweb host, DB via host-gateway`
- [x] ➕ `docs/plans/20260925-close-db-public-exposure.md`: status note at the top (superseded by this plan)

### Task 7: GitHub secrets + first deploy

**Files:** none (GitHub settings)

- [x] repo Settings → Secrets: add `HOST_IP=NEW_IP`, `SSH_PRIVATE_KEY=<contents of ~/.ssh/adskip-deploy>`; set `DB_NAME`, `DB_USER`, `DB_PASSWORD` to the Task 3 values; `NODE_APP_PORT=3022`; `AUTH_TOKEN`, `GF_ADMIN_PASSWORD` (new or reused — see Development Approach); delete `*_YC` secrets (`DB_HOST` is no longer read from secrets — compose hardcodes `host.docker.internal`) → set by hand 2026-10-15
- [x] push `main` (Task 5 + Task 6 commits) → Actions run; or trigger `workflow_dispatch` → pushed `6624f81..43730f9` 2026-10-15; containers up ~3 min later
- [x] on the VM: `docker ps` → `native-ad-skip-api-app-1`, `-prometheus-1`, `-grafana-1` up; `docker logs native-ad-skip-api-app-1` shows `Tables schemas synced` and the listen line, no `Unable to connect to the database` → all three up; app on `127.0.0.1:3022`, prometheus on `127.0.0.1:9090`, `Tables schemas synced`, no DB errors
- [x] verify Go cron: after 2 minutes `docker exec native-ad-skip-api-app-1 tail -5 /tmp/mycron.log` → clean runs for prv/rt/yt, no connection errors → prv/rt/yt ticks ran, log empty: 0 `is_new` markups to process and `ConnectDb()` panics on a failed `Ping`, so silence = connected. First real calculation is exercised in Task 8
- [x] verify: `curl -s https://${API_HOST}/` → `{"status":"ok"}`; `curl -s "https://${API_HOST}/video-calculated?v=1&native_id=<known id from dump>"` returns segments → `{"status":"ok"}`; ➕ the param is `video_id`, not `native_id`: `/video-calculated?v=1&video_id=-1_456000907&duration=2615` → 3 segments, `video_calculated_lookup_total{outcome="match",provider="prv"} 1`. From outside 3022/3024/5432/9090 all closed
- [x] verify Grafana: `http://NEW_IP:3024` from the admin IP (➕ 3024 is not opened in the panel firewall — use `ssh -L 3024:localhost:3024 root@NEW_IP` and `http://localhost:3024`), both datasources "Test" green, dashboards render with live data; from a non-admin IP (phone on mobile data) `:3024` must time out — if it answers, the panel firewall isn't attached (see Task 2) → superseded: 3024 opened to all (see Task 2). `http://${HOST_IP}:3024/login` → 200, `/api/health` → `database: ok`, anonymous `/api/datasources` → 401; datasource "Test" + live dashboards confirmed OK by owner in the browser 2026-10-15

### Task 8: Day-one reachability test from Russia

**Files:** none

- [x] from a Russian phone on mobile data (not Wi-Fi): open `https://${API_HOST}/` in the browser → `{"status":"ok"}` → OK (owner, 2026-10-15)
- [x] from a home wired ISP in Russia: same curl → OK (owner, 2026-10-15)
- [x] load the video platform with the extension installed, play a video that has segments in the dump → skip works; check `docker logs` for the `GET /video-calculated` line and the `/metrics` counter `video_calculated_lookup_total{outcome="match"}` incrementing → skip works (owner); nginx log shows ~175 `/video-calculated` hits from real users within ~20 min of the deploy
- [x] submit a test markup + vote through the extension (or curl per `api/doc/openapi.yaml`) → row appears, next cron tick updates `video_calculateds` → markup half done: real-user markup #12902 (11:22 UTC) and owner's #12903 (11:40 UTC) both processed by the cron (`is_new=false`, 2 `Calculate video finish`, no errors). vote #2782 (+1, 11:43:50 UTC, `POST /vote` → 204) arrived after the first check; `video_calculateds.data` for video 104200 and `prv_calculated_segments` #25260 both `rating = 1`. Full round-trip on a fresh video: lookup 204 → markup #12903 → cron → lookup 200 with segment → vote
- [x] ⚠️ if the phone test fails while the wired one passes: that is the mobile-whitelist problem from the research, not a config bug; no host fix exists — record it and move on → N/A, both passed

### Task 9: Off-host backups

> **Deferred 2026-10-15** → `docs/backlog/offhost-pg-backup-s3.md` (S3 bucket not created yet). Interim: weekly `make pull-dump` to `~/Web/dumps/adskip-prod/` on the owner's Mac, nagged by a local SessionStart hook. First pull 2026-10-15: 1.3 MB, restored cleanly into `postgres:16` (12533 markups / 2629 votes / 1705 users, max markup id 12903).

**Files:**
- Create: `infrastructure/backup/pg-backup.sh`
- Create: `infrastructure/backup/README.md`

- [ ] Timeweb panel → S3 хранилище → create bucket `adskip-backups` (smallest tier), create access key; `apt install -y s3cmd` (or `awscli`), configure with Timeweb's endpoint `https://s3.twcstorage.ru` (check the panel for the exact endpoint/region)
- [x] `infrastructure/backup/pg-backup.sh` (rehearsed in `postgres:16` with `s3cmd` stubbed: success path, failure path exits 1, restore drill row counts match): `runuser -u postgres -- pg_dump <DB_NAME> | gzip > /var/backups/pg/<DB_NAME>-$(date +%F).sql.gz` (peer auth, no password on disk; `pipefail` so a failed dump fails the run), `s3cmd put` to the bucket, delete local files older than 3 days; S3 lifecycle rule expires objects after 30 days (`s3cmd expire` or the panel)
- [ ] install to `/usr/local/bin`, credentials in `/root/.s3cfg` (mode 600), root cron `15 0 * * * DB_NAME=<DB_NAME> /usr/local/bin/pg-backup.sh` (host clock UTC → 03:15 Moscow, low traffic; the original `15 03` was 06:15 MSK / 10:15 Novosibirsk), log to `/var/log/pg-backup.log`. Full recipe: `infrastructure/backup/README.md`
- [ ] run it once by hand; verify `s3cmd ls s3://adskip-backups/` shows today's file and `gunzip -c <file> | head -20` is a valid dump
- [ ] restore drill: `createdb restore_test && gunzip -c <file> | sudo -u postgres psql -v ON_ERROR_STOP=1 -d restore_test` → row counts match prod; `dropdb restore_test`
- [x] commit script + README (`infra: nightly pg_dump to Timeweb S3`)

### Task 10: Disable the stale Grafana pipeline and tidy the old infra references

**Files:**
- Modify: `../native-ad-skip-grafana/.github/workflows/deploy.yml` (delete) or archive the repo
- Modify: `docs/research/20261013-yandex-cloud-outage-analysis.md`, `docs/research/20261014-hosting-selection.md` (one-line "migrated on <date>, see this plan" note at the top)

- [x] `native-ad-skip-grafana`: delete the deploy workflow and add a README line "superseded by `native-ad-skip-api/docker-compose.yml` (grafana service)"; or archive the GitHub repo → workflow deleted + "Superseded" note at the top of its README, commit `c779a0a` in that repo
- [x] add the status line to both research docs → "Status 2026-10-15: migrated (Almaty)" under each title
- [x] update project memory (`project_yc_outage_2026-10.md`, `project_hosting_selection_2026-10.md`) → migration done, new IP, backup bucket name → done 2026-10-15; no S3 bucket yet, backups tracked in new `project_backups.md`

### Task 11: Verify acceptance criteria

- [x] `https://${API_HOST}/` reachable from RU mobile + RU wired (Task 8 evidence) → owner verified 2026-10-15
- [x] markup → calculate → video-calculated → vote round-trip on prod → Task 8 (markup #12903, vote #2782)
- [x] `git push` to `main` redeploys without manual steps (push a trivial commit and watch Actions) → three pushes on 2026-10-15 (incl. the history-rewrite force-push) each restarted the app and answered 200
- [x] `nc -zv -w3 NEW_IP 5432` and `:3022` and `:9090` from outside → closed; `:3024` intentionally open (Grafana login), see Task 2 → checked 2026-10-15
- [ ] ~~yesterday's backup object exists in S3; restore drill passed~~ → out of scope: deferred with Task 9 to `docs/backlog/offhost-pg-backup-s3.md`; interim local dump restore-tested 2026-10-15
- [x] `make test-e2e` green on the committed compose/workflow changes. The 3 failures predated the migration; fixed 2026-10-16 (test seeding hit the `rating ≤ -2` markup gate), 109/109

### Task 12: [Final] Update documentation

- [x] `CLAUDE.md` reflects Timeweb host, nginx/TLS, `host.docker.internal`, backups (done in Task 6/9 — re-read and confirm) → confirmed; added DNS records and an Ops section (`make pull-dump`)
- [ ] ~~`README.md` is empty; add a 10-line "Ops" section pointing at `infrastructure/` and this plan (optional)~~ → skipped: CLAUDE.md Deployment + Ops cover it
- [x] move this plan to `docs/plans/completed/`

## Post-Completion

**Yandex Cloud cleanup**
- Services are free until 2026-10-31. Keep the VM/disk until then in case zone `a` returns; if it does, `pg_dump` the old DB and compare `max(id)`/`max("createdAt")` on `markups`, `markup_time_intervals`, `votes`, `users` against the 2026-10-09 dump. Merging the delta is non-trivial: the new host's sequences continue from the restored values, so ids of lost rows collide with new rows. Expect to accept the ~1.5-day loss unless the delta is large.
- Before 2026-10-31: delete the YC VM, disk, static IP, security group; close the billing account or leave it empty.

**Grafana hardening (follow-up, not blocking)**
- Move `:3024` behind nginx with TLS on `grafana.${DNS_ZONE}` (or a path), bind the container to `127.0.0.1`, drop the ufw admin-IP rule.
- 2026-10-15: `:3024` is currently open to the internet on plain HTTP (owner's choice). Cheapest upgrade is `/grafana/` on the existing API vhost (no DNS/cert work). Independently: give the Postgres datasource a read-only role instead of the app's read-write `DB_USER`.

**C2 plan**
- `docs/plans/20260925-close-db-public-exposure.md` is effectively closed by Task 3 (Postgres never exposed on the new host). Mark it completed with a pointer here; its optional Task 7 (TLS to Postgres) stays optional.

**Cost / capacity watch**
- Cloud 50 at ~3 840 ₽/mo plus S3 and auto-backups. Check the first invoice; downgrade to Cloud 30 only if Prometheus+Grafana are moved off-box.

**Exit route**
- Timeweb's Almaty location is in the same panel; a snapshot → new server there plus a DNS change is the DR path if RF hosting becomes untenable (see hosting-selection research for the 152-FZ caveats).
