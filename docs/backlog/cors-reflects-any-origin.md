---
worth: yes
where: server.js:53
added: 2026-10-16
---
# CORS echoes any Origin with Allow-Credentials: true

The hand-written middleware reflects the request's `Origin` and sets `Access-Control-Allow-Credentials: true`, the combination browsers refuse for `*`. There are no cookies today, so nothing is exploitable now; it turns into a hole the moment a cookie session appears (e.g. the admin-cookie idea in [[admin-token-in-nginx-access-log]]). OPTIONS is not answered, so the clients are evidently extensions that bypass CORS.

Fix: drop `Allow-Credentials` (nothing uses it); optionally the `cors` package with an allowlist once the real client origins are known.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
