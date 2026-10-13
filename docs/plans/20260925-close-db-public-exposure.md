# Close DB Public Exposure

> **Status 2026-10-14: superseded.** The Yandex Cloud host this plan targets is gone (zone `ru-central1-a` outage). Tasks 1–6 are replaced by `docs/plans/20261014-timeweb-migration.md`: on the new host Postgres is never public (Task 3 there), and compose uses `host.docker.internal` via `host-gateway` from the start. Task 7 (TLS to Postgres) stays optional and unscheduled.

## Overview

PostgreSQL is confirmed reachable from the public internet: it binds `0.0.0.0:5432`/`[::]:5432`, the Yandex Cloud Security Group has an ingress rule for TCP 5432 from `0.0.0.0/0` (named "Postgres"), and an external `nc -zv <public-ip> 5432` from outside the VPS's network succeeded. This was verified live during the 2026-09-24 code review (artifact: https://claude.ai/code/artifact/eec43dce-d081-4ddc-9fe6-7efb4dfceea3, finding C2).

App and DB run on the same Yandex Cloud VPS. The app currently connects to Postgres via the VPS's **public** IP (`docker-compose.yml`: `DB_HOST=178.154.241.202` + a matching `extra_hosts: database:<public-ip>` mapping) — a workaround for Docker container→host connectivity, chosen because other approaches ("host.docker.internal" by itself, etc.) reportedly didn't work at the time. Most likely cause: on Linux Docker Engine (the real VPS's OS), the bare hostname `host.docker.internal` does not resolve without the explicit `--add-host=host.docker.internal:host-gateway` flag (Docker 20.10+) — unlike Docker Desktop on Mac, where it works automatically. A second likely blocker: `pg_hba.conf` and/or `ufw`/`iptables` on the host may reject connections arriving from the Docker bridge subnet even once the hostname resolves.

**Goal:** route app↔DB traffic internally (never touching the public interface) and then close the `0.0.0.0/0` Security Group rule — without any prod downtime, and without repeating the "it didn't work, gave up, used the public IP" outcome from last time. The way to avoid a repeat is to validate the exact failure mode and its fix in an isolated environment first, with a rollback path kept live at every prod step.

**Not in scope for this plan:** TLS on the Postgres connection (`sslmode=disable`) is a separate, lower-priority hardening step — once traffic never leaves the box, encryption-in-transit stops being the primary risk. Captured as an optional Task 7 here so it isn't lost, but Tasks 1–6 are the actual fix for the confirmed critical finding.

## Context (from discovery)

**Files involved:**
- `docker-compose.yml` — prod compose: `DB_HOST=178.154.241.202`, `extra_hosts: database:178.154.241.202` (server.js:9)
- `docker-compose.dev.yml` — no own Postgres service; relies on external `.env` (`DB_HOST` points at whatever's configured, likely also the public IP today)
- `docker-compose.e2e.yml` — **already has the right shape to copy**: its own `postgres:15` service (`e2e-db`) on an isolated bridge network (`e2e-network`), app service pointed at it via `DB_HOST: e2e-db`. Good base pattern, but it uses Docker's internal DNS (sibling service in the same compose project) — that's a *different*, already-working case and does **not** exercise the `host.docker.internal`/`host-gateway` path that actually needs validating, because in prod Postgres runs as a host-level service, not a docker-compose sibling.
- `db.js` — Sequelize connection (Node), reads `DB_HOST` from env, no TLS options set
- `calculator/calculate.go` (`ConnectDb`, line ~251) — Go calculator, separate connection to the same DB, also reads `DB_HOST` from env, `sslmode=disable` hardcoded
- `.github/workflows/deploy.yml` — passes `DB_HOST: database` as an env var to the deploy step, which docker-compose then resolves via the `extra_hosts` mapping to the public IP
- `grafana/provisioning/datasources/datasources.yml` — **Grafana has its own direct Postgres datasource** (`url: ${DB_HOST}:5432`, `sslmode: disable`). This is a second, independent consumer of `DB_HOST`/`extra_hosts` beyond the `app` service — easy to miss and break Grafana's dashboards if only `app`'s compose service gets the `host.docker.internal` fix.
- `CLAUDE.md` — Environment Variables section documents `DB_HOST`; needs updating once the value/mechanism changes

**Patterns observed:**
- The project already treats "prove it in an isolated compose stack, then port to prod" as a normal pattern (`docker-compose.e2e.yml` exists for exactly this reason, used by `make test-e2e`).
- Deploys are `docker-compose ... up --build -d app prometheus grafana` over SSH (no CI test gate — separately flagged in the review, not addressed here).

## Development Approach

- **Verification approach (this is infra, not app code — no unit tests):** every task ends in a concrete connectivity/functionality check with the exact command to run. The old (public-IP) path is never removed until the new (internal) path is proven — every step must be trivially revertible by flipping `DB_HOST` back and redeploying.
- **Two-phase sandbox validation, not one:**
  - **Phase A — quick local sanity check (Mac).** Cheap, fast, but **not fully representative**: Docker Desktop on Mac resolves `host.docker.internal` natively even without `host-gateway`, so a success here does not prove the fix will work on the real Linux VPS. Treat as a smoke test only.
  - **Phase B — authoritative check on a disposable Yandex Cloud VM (Linux).** This is the only environment that actually matches prod: same OS, same Docker Engine behavior, same YC networking/Security Group model. This is where the real "why didn't it work last time" gets diagnosed and fixed, safely, with zero risk to the live app or its data.
- Complete each task fully, verify, before moving to the next.
- Update this plan's checkboxes as work happens; note deviations with ⚠️.

## Testing Strategy

No unit/e2e test suite changes are expected — this is infrastructure/network configuration. "Testing" here means:
- Raw TCP reachability: `nc -zv <host> 5432`
- Postgres auth: `psql -h <host> -U <user> -d <db> -c 'select 1'`
- App-level smoke test: app boots, `GET /` responds, a markup/vote round-trip works, Go calculator completes a cron run without error
- External exposure check (the one that actually answers "is this fixed"): `nc -zv -w3 <public-ip> 5432` run from **outside** the VPS's network — must succeed before Task 4, must fail/timeout after Task 5

## What Goes Where

- **Implementation Steps** (checkboxes): sandbox setup, prod compose/config edits, verification commands.
- **Post-Completion**: provisioning/destroying the temporary YC VM, Grafana/traffic monitoring after cutover, updating the published review artifact.

## Implementation Steps

### Task 1: Sandbox — quick local sanity check (Mac)

**Files:**
- Create: `docker-compose.sandbox.yml`

- [ ] create `docker-compose.sandbox.yml`: one `app`-like service, **no** `depends_on`/shared network to a Postgres service (must not use Docker's internal DNS shortcut)
- [ ] add `extra_hosts: - "host.docker.internal:host-gateway"` to that service
- [ ] run a **standalone** Postgres container outside the compose project, publishing to the host's port 5432, to simulate "Postgres installed directly on the host OS" (not a compose sibling): `docker run -d -p 5432:5432 --name sandbox-postgres -e POSTGRES_PASSWORD=test postgres:15`
- [ ] from inside the sandbox app container: `nc -zv host.docker.internal 5432` — confirm reachable
- [ ] `psql -h host.docker.internal -U postgres -c 'select 1'` — confirm auth-level success too, not just TCP
- [ ] note the result and the caveat explicitly in this plan: Mac success is a smoke test, not proof for Linux — do not treat this as sufficient on its own

### Task 2: Sandbox — authoritative check on a disposable Yandex Cloud VM (Linux)

**Files:**
- none (temporary infra only, nothing committed to the repo)

- [ ] provision a temporary, cheapest-tier Yandex Cloud VM running the same Ubuntu version as prod — throwaway, no real data
- [ ] install PostgreSQL **directly on the VM** via `apt` (systemd service, not Docker) — this matches prod's real topology, unlike Task 1
- [ ] install Docker Engine on the VM; build/run the app image (or a minimal stand-in container) with `extra_hosts: - "host.docker.internal:host-gateway"`
- [ ] from inside the container: `nc -zv host.docker.internal 5432` — record pass/fail
- [ ] `psql -h host.docker.internal -U <user> -d <db> -c 'select 1'` — record pass/fail
- [ ] if either fails, diagnose and fix on this throwaway VM (not prod): check `pg_hba.conf` for a rule covering the Docker bridge subnet (`docker network inspect bridge` to get the CIDR, typically `172.17.0.0/16`) with `scram-sha-256`/`md5` auth; check `ufw status` / `iptables -L` for rules blocking traffic from `docker0`
- [ ] once both checks pass cleanly, run the actual app (this repo, built from the VM) against this Postgres via `host.docker.internal` and do an app-level smoke test: boots, `GET /` returns 200, a `POST /markup` + `POST /vote` round-trip works
- [ ] write down the exact working recipe (compose snippet, `pg_hba.conf` line added, any `ufw`/`iptables` exception) — this becomes the checklist for Task 3
- [ ] ➕ destroy the temporary VM once the recipe is confirmed (cost cleanup — see Post-Completion)

### Task 3: Prod — add the internal path in parallel (old path stays live)

**Files:**
- Modify: `docker-compose.yml` (on the VPS, staged — not committed until Task 4 confirms it works)

- [ ] on the real VPS, apply the Task 2 recipe to prod's `app` **and** `grafana` services: add `extra_hosts: - "host.docker.internal:host-gateway"` to both (alongside the existing public-IP `extra_hosts`/`DB_HOST`, not replacing it yet) — Grafana has its own direct Postgres datasource and needs the same fix, not just `app`
- [ ] apply the confirmed `pg_hba.conf` addition (allow the Docker bridge subnet) — this is a Postgres config **reload**, not a restart; no downtime
- [ ] apply the confirmed `ufw`/`iptables` exception if Task 2 needed one
- [ ] from inside the **running** prod app container (`docker exec -it <container> sh`): `nc -zv host.docker.internal 5432` and `psql -h host.docker.internal -U <user> -d <db> -c 'select 1'` — confirm success, **without** touching the live `DB_HOST` env var (real traffic still flows over the public IP at this point)
- [ ] repeat the same check from inside the `grafana` container
- [ ] ⚠️ do not proceed to Task 4 until this check passes cleanly on the real prod host, for both containers, not just the sandbox VM

### Task 4: Prod — cut over `DB_HOST` to the internal path

**Files:**
- Modify: `docker-compose.yml` (`DB_HOST` value, `extra_hosts` for the `database` alias)

- [ ] change `DB_HOST` (and the `database` alias in `extra_hosts`) from the public IP to `host.docker.internal` for both `app` and `grafana` services
- [ ] redeploy/restart the `app` and `grafana` services (not the whole stack), during a low-traffic window
- [ ] verify: app boots cleanly, `GET /` returns 200, `/metrics` shows fresh scrapes, a real `POST /markup` + `POST /vote` round-trip works end-to-end
- [ ] verify Grafana's PostgreSQL datasource still connects (Grafana UI → Data sources → PostgreSQL → "Test") and that any dashboard panel backed by it still renders
- [ ] verify the Go calculator (separate connection, `calculator/calculate.go`) still connects — check `/tmp/mycron.log` inside the container for a clean run on the next minute's cron tick
- [ ] keep the old public-IP wiring commented out (not deleted) in compose for at least 24–48h as an instant rollback option
- [ ] ⚠️ if anything breaks: revert `DB_HOST`/`extra_hosts` to the public IP for the affected service(s), redeploy, done — old path was never removed

### Task 5: Close the public exposure

**Files:**
- none (Yandex Cloud console/CLI — Security Group, not repo code)

- [ ] after the internal path has run stable for the soak period from Task 4, remove the `0.0.0.0/0` ingress rule for TCP 5432 in the Yandex Cloud Security Group (or narrow it to a specific admin IP/CIDR if occasional direct `psql` access is genuinely needed for maintenance)
- [ ] re-run the external reachability check from outside the VPS's network: `nc -zv -w3 <public-ip> 5432` — must now time out/fail (this is the actual confirmation the finding is closed)
- [ ] confirm the app is still fully functional after the Security Group change (same checks as Task 4)

### Task 6: Clean up leftover public-IP wiring

**Files:**
- Modify: `docker-compose.yml`
- Modify: `CLAUDE.md` (Environment Variables / Deployment sections)

- [ ] remove the now-dead public-IP `DB_HOST` value and `extra_hosts: database:<public-ip>` lines from `docker-compose.yml` (both prod and, if applicable, `docker-compose.dev.yml`)
- [ ] `grep -rn "178.154.241.202"` across the repo to confirm nothing else still references the hardcoded IP
- [ ] update `CLAUDE.md`'s Environment Variables section to describe the new `DB_HOST` convention (internal host-gateway, not a public IP)
- [ ] run `make test-e2e` locally as a general sanity check that nothing else broke from the compose edits
- [ ] commit the cleanup

### Task 7 (optional, lower priority): TLS on the Postgres connection

**Files:**
- Modify: `db.js`
- Modify: `calculator/calculate.go`

- [ ] enable `ssl = on` in `postgresql.conf` on the VPS (reload, not restart)
- [ ] add `dialectOptions.ssl` to the Sequelize connection in `db.js`
- [ ] change `sslmode=disable` → `sslmode=require` in `calculator/calculate.go`'s `ConnectDb`
- [ ] validate in sandbox first (same Phase A/B approach as Tasks 1–2), then prod with the same parallel-path caution as Tasks 3–4
- [ ] note: do this only after Task 5 is confirmed — once traffic no longer leaves the box, this is defense-in-depth, not the primary fix, and isn't worth the risk of doing first

### Task 8: Verify acceptance criteria

- [ ] external `nc`/`psql` to `<public-ip>:5432` fails/times out from outside the VPS network
- [ ] app and Go calculator fully functional via the internal path (markup/vote round-trip + a clean cron run)
- [ ] no leftover references to the public-IP DB routing anywhere in the repo
- [ ] the rollback path was actually exercised at least once during Tasks 3–4 (not just theoretically available)

### Task 9 (Final): Update documentation

- [ ] update `CLAUDE.md` if the `DB_HOST`/environment variable conventions changed (should already be done in Task 6, verify here)
- [ ] update the published review artifact (https://claude.ai/code/artifact/eec43dce-d081-4ddc-9fe6-7efb4dfceea3) marking finding C2 as remediated, with the verification evidence
- [ ] update the project memory note (`project_code_review_2026-09.md`) reflecting C2's resolution
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual/external action — no checkboxes, informational only.*

**Temporary sandbox VM (Task 2):**
- Confirm the Yandex Cloud billing for the disposable VM stops after it's destroyed — check the console, not just the terminal command's exit code.

**Post-cutover monitoring:**
- Watch the Grafana dashboards (`http_request_duration_seconds`, error rates) for a day or two after Task 4's cutover for anything the smoke tests didn't catch — connection pool exhaustion, latency changes, etc.

**Documentation outside this repo:**
- None currently known. (Grafana's direct Postgres datasource dependency on `DB_HOST` was already found and folded into Tasks 3–4 — not a loose end.)
