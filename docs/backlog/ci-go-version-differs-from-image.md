---
worth: yes
where: .github/workflows/deploy.yml:26
added: 2026-10-17
---
# CI runs the Go unit tests on Go 1.19, the image builds with Go 1.27

The `test` job's `actions/setup-go` uses `go-version-file: go.mod`, and `go.mod` says `go 1.19`, so `go test -mod=vendor ./calculator` runs on 1.19 (EOL). The Dockerfile's build stage is `golang:1.27-bookworm`, so the shipped binaries come from a different toolchain than the one the unit tests use. `make test-e2e` does run the image's binaries, so the calculator is still tested as shipped; only the unit tests lag.

Fix: set `go-version` in the workflow to the Dockerfile's minor (`1.27`), or bump the `go` directive in `go.mod` (changes language semantics such as per-iteration loop variables from 1.22, so run the tests after). Keep the two in step when the Dockerfile tag moves.

Found while moving the image to a multi-stage build on 2026-10-17.
