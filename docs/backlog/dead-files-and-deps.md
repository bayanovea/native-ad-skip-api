---
worth: yes
added: 2026-10-16
---
# dead dependency, scratch file and unused config in the repo

- `mysql2` in `package.json`: the app is Postgres-only.
- `qqq.go` at the repo root: a one-off analysis script with real video/duration data.
- `config/config.js`: sequelize-cli leftover, nothing loads it (confirmed during the review-page work).
- `swagger-ui` service in `docker-compose.yml`: deploy starts only `app prometheus grafana`, so it never runs on prod; the app already serves the spec at `/api/doc`.

Delete all four.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
