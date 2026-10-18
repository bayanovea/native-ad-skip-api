---
worth: yes
where: grafana/provisioning/alerting/rules.yml:1
added: 2026-10-18
---
# review what is measured and what else should alert in Telegram

Since 2026-10-18 Grafana sends alerts to Telegram (contact point from `docker-compose.yml` `configs:`, rules in
`grafana/provisioning/alerting/rules.yml`): `CalculatorStale` (no successful calculator run for 10 min) and
`Http5xx` (more than 5 in 5 min). Both were chosen to prove the pipeline, not as coverage.

What exists to alert on today: Prometheus `up` for the app scrape, `http_request_duration_seconds` (rate,
latency, status), `video_calculated_lookup_total{outcome}`, `request_without_version_total`,
`calculator_*_timestamp_seconds{provider}`; and the Postgres datasource for anything in the tables (markups
with `is_new` older than N minutes, markups/votes per day, `calculator_heartbeats.failed_videos`).

To do: go through the dashboards and the metric list, decide per signal whether it deserves a Telegram
alert and at what threshold, and add the rules. Candidates: API down (`up == 0` for 2 min; today a dead app
only shows as missing data), p95 latency, `not_found`/`mismatch` share of `/video-calculated` lookups,
`failed_videos > 0` for several runs in a row (a video that keeps failing already keeps `last_success_at`
stale, so `CalculatorStale` fires after 10 min, but the message does not say which video), `is_new` markups older than
10 min (calculator skipping a locked row forever), Prometheus/Grafana themselves down (needs an external
check), host disk and TLS expiry (no node_exporter / blackbox yet; decide whether to add them or use Timeweb
monitoring). Also tune `policies.yml` (repeat interval, grouping) once there is more than one rule firing.
