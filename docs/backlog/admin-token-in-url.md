---
worth: yes
where: prv/routes/admin.js:18
added: 2026-10-16
---
# admin pages take AUTH_TOKEN in the URL

Every admin page and the Grafana GET endpoints authenticate with `?verifyBearerToken=<AUTH_TOKEN>` (`prv/routes/admin.js`, `admin-moderation.js`, `admin-review.js`, the GET variants in `markups.js` / `votes.js`), and the pages put it back into every link and `fetch` URL they render. The host nginx access log no longer records it (`redacted` log format, `infrastructure/nginx/`, 2026-10-17) and the app's error log redacts it (`lib/redact-request.js`), but the token still ends up in browser history, in the referer of the admin pages that send one (all except `/admin/review`), and in nginx's `error.log`, which has no configurable format and writes the full request line, upstream URL and referer of every request that fails upstream (e.g. a 502 during a deploy's container swap).

Fix: a cookie set once from the token (e.g. a login form, or a one-time `?verifyBearerToken=` that sets an `HttpOnly; Secure; SameSite=Strict` cookie and redirects to the clean URL), checked by the admin routes instead of the query param. The Grafana data links are cross-site GETs that change data (delete votes/markups, update rating): a `Strict` cookie is not sent on them, and a `Lax` one would make those GET endpoints CSRF-able, so they need their own answer. CORS no longer sends `Access-Control-Allow-Credentials` since 2026-10-17, so the reflected Origin does not expose such a cookie.
