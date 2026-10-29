---
worth: yes
where: lib/schema.js (renameLegacyObjects), .github/workflows/deploy.yml
added: 2026-10-29
---
# Deployment values that live outside the repo

Since 2026-10-29 the hosts, the platform URL templates, the earlier DB prefix and the compose
project name come from GitHub secrets (`API_HOST`, `LANDING_HOST`, `PROVIDER_*`, `LEGACY_PRV`,
`COMPOSE_PROJECT`, see CLAUDE.md → Deployment). What that leaves open:

- **Grafana community names.** `product-stats.json` has no value mappings for owner ids any more
  (panels 17 and 19). Provisioned dashboards are overwritten on every deploy, so labels for owner
  ids need either a UI edit after each deploy or a render step like the hosts'.
- **Rollback across the rename** is by hand (CLAUDE.md → Deployment → Rollback): an image older
  than 2026-10-29 cannot start on the renamed tables. One reverse SQL script, kept with the other
  deployment values, would make it one step.
- **Detector sync** needs a clean eval checkout; the eval's `internal/provider` takes platforms from
  config, so a sync brings nothing platform-specific.
