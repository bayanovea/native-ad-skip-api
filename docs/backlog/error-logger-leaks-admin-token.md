---
worth: yes
where: server.js:80
added: 2026-10-16
---
# error handler logs AUTH_TOKEN from headers and query

The global error handler logs full `headers` (`authorization: Bearer …`) and `query` (`verifyBearerToken=…`) for every 500, so any failing admin request writes the one admin token to container stdout. All admin pages, Grafana GET endpoints and `/admin/review` carry it in the URL. Since Timeweb, host nginx also writes the full request URI, token included, to `/var/log/nginx/access.log`.

Fix: redact `authorization` and `verifyBearerToken` in the error logger (one line). Optionally a `log_format` without the query string for the vhost in `infrastructure/nginx/`. Longer term: a cookie set once from the token instead of the token in every URL.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
