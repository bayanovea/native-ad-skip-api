---
worth: yes
where: Dockerfile:12
added: 2026-10-16
---
# Go is built with Debian's apt golang (1.19, no security updates)

The image installs `golang` from bookworm's repo (1.19, EOL), and `go.mod` says `go 1.19`. `git` and the Go toolchain also stay in the runtime image.

Fix: multi-stage build, `FROM golang:1.23 AS build` builds the three binaries, the Node stage copies them in. Removes git/golang from the runtime image too. Can go together with [[calculator-recalc-not-atomic]].

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
