---
worth: yes
where: docker-compose.yml (configs.grafana-contact-points), ai/audit/notify.go
added: 2026-11-02
---
# Telegram is unreachable from the prod host: no alert and no audit ping arrives

2026-11-01: `api.telegram.org` times out on 443 from the host (IPv4 and IPv6), the `app` container and the `grafana` container; 149.154.166.110, 149.154.167.220 and 91.108.56.130 all time out, while Anthropic, OpenAI and the video platform work. The owner received Grafana's test alerts after the move to Almaty, so the block came later; Grafana's logs before its 2026-11-01 19:12 recreate are gone, so when is unknown. Since then every Grafana alert (the only contact point is `telegram`) is lost silently, and nothing alerts on that, since the alert itself would go the same way (`alerting-host-and-external-checks.md`). The audit's ping (`ai audit`, first prod run: audit 2 `notified_at` NULL) fails the same way.

Cost so far: on 2026-11-03 `ai judge` failed every tick from 03:30 to 23:30 ICT (JSON null `data`, fixed in 8be8e0d / e93e17f); `CalculatorStale` for `ai_judge` fired after 2 h and nobody saw it, it came out only in a manual check.

Options, owner to pick: a Cloudflare Worker relay (route `/bot…/sendMessage` for the audit via `TELEGRAM_API_URL`, no code change; route `/grafana` taking Grafana's webhook and calling `sendMessage` with the bot token as a worker secret, the contact point becomes `webhook`); an outbound proxy outside KZ via `HTTPS_PROXY` (both Go and Grafana honour it, no code change, needs a server); SMTP mail for Grafana (the audit stays page-only). Recommended: the worker. After the fix: send a Grafana test alert, run `ai audit <batch>` once, and add an outside check that would notice the next block.
