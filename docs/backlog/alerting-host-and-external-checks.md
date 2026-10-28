---
worth: later
where: grafana/provisioning/alerting/policies.yml:3
added: 2026-10-18
---
# alert on the monitoring itself (needs an external check)

Since 2026-10-28 the stack also watches the host and the public path: node-exporter and blackbox-exporter in
`docker-compose.yml`, rules `HostDiskLow`, `HostMemoryLow`, `ProbeFailed`, `TlsCertExpiry` (CLAUDE.md → Alerting).
What is still blind:

- **Prometheus / Grafana themselves down, or the whole host.** Nothing in the stack can report that the stack is
  down: no rule fires when Grafana or Prometheus is the thing that died, or when the VM is gone. Needs an external
  check on the owner's account with an uptime service: `GET https://${API_HOST}/` (200) and Grafana
  `http://${HOST_IP}:3024/api/health`, alerting to Telegram or mail. The blackbox probe runs from the prod host to its
  own public IP, so it also never shows what an outside client sees (routing, the Timeweb firewall).
  Setup (owner, ~5 min, deferred 2026-10-28): UptimeRobot free plan, two HTTP(s) monitors at 5 min (`API`, `Grafana`),
  Telegram integration or the default mail.
- **`policies.yml` tuning.** One route (group by alertname, `group_wait 30s`, `group_interval 5m`,
  `repeat_interval 4h`). Revisit once several rules have fired for real: an outage fires `ApiDown`,
  `HttpLatencyP95`, `CalculatorStale`, `StaleMarkups` and now `ProbeFailed` within a few minutes and each is its own
  Telegram message.
