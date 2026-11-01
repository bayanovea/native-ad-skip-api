---
worth: soon
where: docker-compose.yml (configs.grafana-contact-points), the owner's Mac (Docker Compose v2.17.3)
added: 2026-11-02
---
# `docker compose config` fails on the Mac

`docker compose -f docker-compose.yml config` on the owner's Mac stops with `configs.grafana-contact-points Additional property content is not allowed`: inline `configs: … content:` needs Compose 2.23.1+, the Mac has 2.17.3 (prod has 2.40.3, so deploys are unaffected). Every task that says "verify with `docker compose config`" cannot run locally, as in review-batch-audit 3.2. Fix: upgrade Docker Desktop / the compose plugin on the Mac to ≥ 2.23.1, then re-run the check once.
