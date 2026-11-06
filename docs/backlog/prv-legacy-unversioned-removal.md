---
worth: yes
where: prv/routes/markups.js:33, prv/routes/videos.js:28, prv/routes/index.js:17 (legacyUnversioned), request_without_version_total
added: 2026-11-06
---
# How many prv clients still send no `v`, and can the legacy branch go

prv keeps a branch for its oldest clients: a request without `v` gets the video id with a leading `-` (`legacyUnversioned`, prv only; rt/yt only count such requests). Every current client sends `v`, so this branch only serves installs that never auto-updated.

Measure first: `request_without_version_total{provider="prv", method}` over the last 30 days against all prv requests (`video_calculated_lookup_total{provider="prv"}` for GET, markup counts for POST). No metric splits traffic by the `v` value itself, so "how many are on old versions" is not visible today: add a bounded label (major.minor, unknown → `other`) or a sampled log before deciding on per-version cut-offs.

Decide: if no-`v` traffic is negligible, drop `legacyUnversioned` and its two branches, answer no-`v` requests with 400 (or the normal path, as rt/yt do), and remove the `-`-prefix note from docs/reference/metrics.md and routes.md. Check first whether `-`-prefixed rows written by those clients are still read anywhere (calculator, dashboards).
