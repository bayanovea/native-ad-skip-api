# Grafana Consolidation into Main Repo

## Overview

Move Grafana from a separate `native-ad-skip-grafana` repo into the main `native-ad-skip-api` repo.
Dashboards become code via Grafana provisioning (JSON files). Everything deploys together from a single CI workflow.

**Acceptance criteria:** Grafana reachable on `:3024` after deploy, all 4 dashboards visible without manual setup, infrastructure dashboard shows HTTP metrics, no references to `native-ad-skip-grafana` remain in active deployment.

## Context (from discovery)

- `server.js` — Express entry point; `express-prom-bundle` already installed and wired (Task 1 pre-done)
- `docker-compose.yml` — needs `grafana:` service added
- `.github/workflows/deploy.yml` — line 63 starts only `app`; needs to also start `grafana`
- 4 dashboards exported to `/Users/bayanovea/Web/dumps/grafana/`
- Two datasources: Postgres (UID `ce68e9be-35fa-4d6a-8f59-35f03dae1d52`), Prometheus (UID `c62ca5db-1b9b-4b36-a039-145154b708ae`)
- Grafana version exported from: `12.3.1` (from dashboard JSON `pluginVersion`)
- Old compose project `native-ad-skip-grafana` has volume `native-ad-skip-grafana_grafana_data` — will not carry over (fresh volume, dashboards are now code so this is acceptable)

## Development Approach

- **testing approach**: Regular (no unit tests applicable — infra/config changes only)
- Verify each task manually before proceeding

## Solution Overview

1. Create `grafana/` directory with provisioning configs and dashboard JSONs
2. Provisioning auto-wires datasources and dashboards on container start — no manual UI setup
3. Datasource UIDs in `datasources.yml` match existing dashboard JSON UIDs exactly
4. Grafana service added to `docker-compose.yml` using `grafana/grafana:12.3.1` (pinned, matches export version)
5. Grafana needs `extra_hosts: "database:178.154.241.202"` to resolve `database` hostname (same as `app` service)
6. Dashboards set to `"editable": false` (code is source of truth; UI edits don't persist anyway)
7. Deploy workflow starts `app grafana` explicitly; `prometheus` continues unmanaged (already running)
8. `GF_ADMIN_PASSWORD` added as GitHub secret, propagated through all SSH layers
9. Old `native-ad-skip-grafana_grafana_data` volume is not migrated — fresh start, dashboards are code

## Implementation Steps

### Task 1: ~~Add express-prom-bundle~~ (already done)

`express-prom-bundle` is installed and configured in `server.js:16-35`. No action needed.

- [x] `express-prom-bundle` wired into Express with path/method/status normalization

---

### Task 2: Create Grafana provisioning config

**Files:**
- Create: `grafana/provisioning/datasources/datasources.yml`
- Create: `grafana/provisioning/dashboards/dashboards.yml`

- [x] create `grafana/provisioning/datasources/datasources.yml` with Postgres datasource:
  - UID: `ce68e9be-35fa-4d6a-8f59-35f03dae1d52`
  - host: `${DB_HOST}:5432` (resolves to `database:5432` via `extra_hosts`)
  - database/user/password from env vars
  - `sslmode: disable`, `postgresVersion: 1400`, `timescaledb: false`
- [x] add Prometheus datasource to same file:
  - UID: `c62ca5db-1b9b-4b36-a035-145154b708ae`
  - url: `http://prometheus:9090`
- [x] create `grafana/provisioning/dashboards/dashboards.yml` with file provider pointing to `/var/lib/grafana/dashboards`, `allowUiUpdates: false`
- [x] verify YAML is valid

### Task 3: Copy and clean dashboard JSONs

**Files:**
- Create: `grafana/dashboards/product-stats.json`
- Create: `grafana/dashboards/tables.json`
- Create: `grafana/dashboards/infrastructure.json`
- Create: `grafana/dashboards/assessors.json`

- [x] copy `Продуктовая статистика` → `grafana/dashboards/product-stats.json`:
  - set top-level `"id": null` (prevents collision with old volume data)
  - set `"editable": false`
  - keep Cyrillic `"title"` field unchanged (UI displays title, not filename)
  - remove `__inputs`/`__requires` keys if present
- [x] same cleanup for `Таблицы в чистом виде` → `grafana/dashboards/tables.json`
- [x] same cleanup for `Инфрастуктура` → `grafana/dashboards/infrastructure.json`
- [x] same cleanup for `Асессоры` → `grafana/dashboards/assessors.json`
- [x] verify all 4 datasource UIDs match provisioned ones

### Task 4: Add Grafana service to docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [x] add `grafana:` service (image `grafana/grafana:12.3.1`, pinned, `restart: unless-stopped`, port `127.0.0.1:3024:3024`, `extra_hosts`, `depends_on: [prometheus]`, volumes, env, `main-network`)
- [x] add `grafana_data:` to top-level `volumes:` section
- [x] run `docker-compose config` — valid (expected warnings for unset env vars locally)

### Task 5: Update deploy workflow

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [x] add `GF_ADMIN_PASSWORD: ${{ secrets.GF_ADMIN_PASSWORD }}` to the `Deploy to YC` step's `env:` block
- [x] add `export GF_ADMIN_PASSWORD='$GF_ADMIN_PASSWORD'` to remote shell exports
- [x] changed `up --build -d app` to `up --build -d app grafana`
- [x] workflow file is valid YAML

### Task 6: Add CI secret

**(External action — GitHub repo settings)**

- [ ] add `GF_ADMIN_PASSWORD` secret to GitHub Actions repo secrets (value: from old grafana `.env`)

### Task 7: Verify acceptance criteria

- [ ] run `docker-compose config` — no errors
- [ ] start grafana locally: `docker-compose up -d grafana` — container starts healthy
- [ ] open Grafana at `localhost:3024` — login works with admin password
- [ ] Connections → Data sources — both Postgres and Prometheus appear
- [ ] open **Продуктовая статистика** — panels render (Postgres + Prometheus)
- [ ] open **Таблицы в чистом виде** — panels render (Postgres)
- [ ] open **Инфрастуктура** — all 6 HTTP panels render (Prometheus)
- [ ] open **Асессоры** — panels render (Postgres)
- [ ] confirm deploy workflow passes in CI after push

### Task 8: [Final] Update documentation

- [ ] update CLAUDE.md: add `grafana/` to Key Directories table with note "Grafana provisioning configs and dashboard JSONs; service runs on port 3024"
- [ ] remove literal password from this plan file before commit (replaced with placeholder in Task 6 above)
- [ ] move this plan to `docs/plans/completed/`

## Post-Completion

**Decommission old repo:**
- Stop and remove the old `native-ad-skip-grafana` container on the server: `docker stop <id> && docker rm <id>`
- Archive or delete the `native-ad-skip-grafana` GitHub repo

**Cleanup:**
- Rotate the Grafana admin password after migration is confirmed stable
- Old volume `native-ad-skip-grafana_grafana_data` can be removed once confirmed: `docker volume rm native-ad-skip-grafana_grafana_data`

**Note on volume migration:**
The old Grafana user state (folders, alert history, API keys) is not migrated — this is intentional since dashboards are now code. Accept the fresh start.
