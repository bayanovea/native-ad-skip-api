---
worth: yes
where: infrastructure/nginx/api.conf:18
added: 2026-10-16
---
# host nginx logs AUTH_TOKEN in the access log

The vhost sets no `access_log`, so the host nginx writes the default `combined` format to `/var/log/nginx/access.log`: the full request URI, `?verifyBearerToken=…` included, for every admin page, Grafana GET endpoint and `/admin/review` request. Its referer field carries the token as well for the requests those pages make (every admin page except `/admin/review` sends a same-origin `Referer`). The app's own error log no longer prints the token (`lib/redact-request.js`).

Fix: a `log_format` with `$uri` instead of `$request` and no `$http_referer` (it goes in the `http` context, e.g. `/etc/nginx/conf.d/`, not the server block), `access_log … <format>;` in the 443 server, then copy to the host and reload by hand (`infrastructure/nginx/README.md`); purge or rotate out the existing logs. Longer term: a cookie set once from the token instead of the token in every URL (CORS no longer sends `Access-Control-Allow-Credentials` since 2026-10-17, so the reflected Origin does not expose such a cookie).
