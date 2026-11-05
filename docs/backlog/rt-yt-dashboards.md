---
worth: later
where: grafana/dashboards/product-stats.json, tables.json, grafana/provisioning/alerting/rules.yml (StaleMarkups), config/prometheus.yml (blackbox), lib/player-link.js, ai/platform, PROVIDER_VIDEO_URL / PROVIDER_LINK_AT
added: 2026-11-05
---
# rt/yt are invisible on the dashboards and have no platform links

Since 2026-11-05 `rt` and `yt` mount the prv routes and are about to get clients, but everything that watches the data reads only the prv tables: the `product-stats` and `tables` dashboards query `markups`, `videos`, `votes`, `video_calculateds`; the `StaleMarkups` alert counts only `markups` (its comment says rt/yt have no data). The lookup metric and the calculator heartbeats already carry `provider`, so `infrastructure.json` sees rt/yt; nothing else does. The platform templates are single-valued: `PROVIDER_VIDEO_URL` and `PROVIDER_LINK_AT` describe the prv platform only, so any rt/yt link (dashboards, admin pages, `linkAt`) would point at the wrong site.

When rt/yt rows show up on prod: add a provider variable (or rt/yt panels) to `product-stats` / `tables`, make `StaleMarkups` count `rt_markups` / `yt_markups` too, and give the templates a per-provider form (e.g. `PROVIDER_VIDEO_URL_RT`) wired through the render step and the deploy secrets.

The blackbox job probes only `https://${API_HOST}/` and `https://${LANDING_HOST}/`; the rt and yt landings (two more hosts on this server, and the `:8443` preview of the new prv landing) have no probe, so `ProbeFailed` / `TlsCertExpiry` miss them. Optional: add them to `config/prometheus.yml` as deploy variables next to `LANDING_HOST` once they are live.
