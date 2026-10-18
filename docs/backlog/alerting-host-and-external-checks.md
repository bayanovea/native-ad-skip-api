---
worth: yes
where: grafana/provisioning/alerting/rules.yml:1
added: 2026-10-18
---
# alert on the host and on the monitoring itself (needs an external check)

Since 2026-10-19 `grafana/provisioning/alerting/rules.yml` covers the app and the calculator: `ApiDown`,
`Http5xx`, `HttpLatencyP95`, `CalculatorStale`, `CalculatorFailedVideos`, `StaleMarkups`,
`LookupNotFoundShare` (CLAUDE.md → Alerting). node_exporter / blackbox_exporter were deliberately not added
in that batch (no new compose service). What is still blind:

- **Host disk and memory.** Prometheus is capped at 2 GB, Postgres and `docker logs` are not. Needs
  node_exporter in the compose stack (then `node_filesystem_avail_bytes`, `node_memory_MemAvailable_bytes`)
  or Timeweb's own VM monitoring with its alerting.
- **TLS expiry.** certbot renews by itself, but a failed renewal only shows when the cert expires. Needs
  blackbox_exporter (`probe_ssl_earliest_cert_expiry`) or an external uptime service that checks the cert.
- **Prometheus / Grafana themselves down.** Nothing in the stack can report that the stack is down; the
  `ApiDown` rule does not fire when Grafana is the thing that died. Needs an external check (an uptime
  service hitting `GET /` of the API and Grafana's `/api/health`, or a Grafana Cloud free-tier heartbeat).
- **`policies.yml` tuning.** One route (group by alertname, `group_wait 30s`, `group_interval 5m`,
  `repeat_interval 4h`). Revisit once several rules have fired for real: an outage fires `ApiDown`,
  `HttpLatencyP95`, `CalculatorStale` and `StaleMarkups` within a few minutes and each is its own
  Telegram message.

Decide first whether to add exporters (new compose services, more scrape targets) or to lean on Timeweb
monitoring plus one external uptime check; the external check is needed in both cases.
