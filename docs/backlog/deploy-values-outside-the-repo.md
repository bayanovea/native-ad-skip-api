---
worth: yes
where: grafana/dashboards/product-stats.json, scripts/sync-detector.sh
added: 2026-10-29
---
# Deployment values that live outside the repo

Since 2026-10-29 the hosts, the platform URL templates, the earlier DB prefix and the compose
project name come from GitHub secrets (`API_HOST`, `LANDING_HOST`, `PROVIDER_*`, `LEGACY_PRV`,
`COMPOSE_PROJECT`, see CLAUDE.md → Deployment). What that leaves open:

- **Grafana community names.** `product-stats.json` has no value mappings for owner ids any more
  (panels 17 and 19). Provisioned dashboards are overwritten on every deploy, so labels for owner
  ids need either a UI edit after each deploy or a render step like the hosts'.
- **Detector sync** needs a clean eval checkout; the eval's `internal/provider` takes platforms from
  config, so a sync brings nothing platform-specific.
