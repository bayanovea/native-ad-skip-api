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
7. Deploy workflow uses `docker-compose down` before `up` to avoid docker-compose v1 `ContainerConfig` bug on recreation
8. `GF_ADMIN_PASSWORD` added as GitHub secret, propagated through all SSH layers
9. Old `native-ad-skip-grafana_grafana_data` volume is not migrated — fresh start, dashboards are code
10. Grafana port bound to `0.0.0.0:3024` (not `127.0.0.1`) to allow public access

## Implementation Steps

### Task 1: ~~Add express-prom-bundle~~ (already done)

- [x] `express-prom-bundle` wired into Express with path/method/status normalization (`server.js:16-35`)

### Task 2: Create Grafana provisioning config

- [x] `grafana/provisioning/datasources/datasources.yml` — Postgres + Prometheus datasources with correct UIDs
- [x] `grafana/provisioning/dashboards/dashboards.yml` — file provider, `allowUiUpdates: false`
- [x] YAML valid

### Task 3: Copy and clean dashboard JSONs

- [x] 4 dashboards copied to `grafana/dashboards/` with `id: null`, `editable: false`, Cyrillic titles preserved
- [x] All datasource UIDs verified to match provisioned ones

### Task 4: Add Grafana service to docker-compose.yml

- [x] `grafana:` service added (`grafana/grafana:12.3.1`, `restart: unless-stopped`, `0.0.0.0:3024:3024`, `extra_hosts`, `depends_on: [prometheus]`, volumes, env)
- [x] `grafana_data:` volume added
- [x] Port changed to `3024:3024` (public) to match original `docker run` behavior

### Task 5: Update deploy workflow

- [x] `GF_ADMIN_PASSWORD` added to step env and remote exports
- [x] `docker-compose down` added before `up` (fixes docker-compose v1 `ContainerConfig` bug)
- [x] Deploy starts `app grafana` together

### Task 6: Add CI secret

- [x] `GF_ADMIN_PASSWORD` secret added to GitHub Actions repo secrets

### Task 7: Verify acceptance criteria

- [x] Grafana container running at `:3024` confirmed via `docker ps`
- [x] Grafana accessible at `http://178.154.241.202:3024/`
- [x] Deploy workflow passes in CI

### Task 8: [Final] Update documentation

- [x] CLAUDE.md updated — `grafana/` added to Key Directories table
- [x] Plan moved to `docs/plans/completed/`

## Post-Completion

**Decommission old repo:**
- Stop and remove the old `native-ad-skip-grafana` container on the server: `docker stop <id> && docker rm <id>`
- Archive or delete the `native-ad-skip-grafana` GitHub repo

**Cleanup:**
- Rotate the Grafana admin password after migration is confirmed stable
- Old volume `native-ad-skip-grafana_grafana_data` can be removed: `docker volume rm native-ad-skip-grafana_grafana_data`
