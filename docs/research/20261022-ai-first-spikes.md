# AI-first segments: spikes (Task 0)

Date: 2026-10-22. Plan: `docs/plans/completed/20261022-ai-first-segments.md`, Task 0.

> **Status: local part done, prod-host part deferred.** The build check below was measured on the
> owner's Mac (Docker, arm64 images; Go binaries also cross-built for linux/amd64). Everything that
> needs the prod host's KZ IP (yt-dlp reachability, subtitle readiness, views) is not measured yet;
> the owner runs it later. Until then the plan's placeholder constants stay.

## Build check (measured)

Done in a throwaway copy of the repo at `4d06309`, nothing committed: the five eval packages
(`detector` without `claudecli.go`, `transcript`, `vtt`, `provider`, `ytdlp`, eval `cb4f312`) copied
to `ai/` with the import path rewritten to `odedohbest/video-calculate/ai/…`, a stub
`prv/commands/ai/main.go` that links `NewAnthropic`, `NewAnthropicBatch`, `provider.Lookup` and
`ytdlp.Runner.Info`, and the Dockerfile `go-build` stage extended by one `go build` line plus a
`COPY --from=go-build` of the binary.

- `go.mod` `go 1.19` → `go 1.27` + `github.com/anthropics/anthropic-sdk-go v1.80.0` (the eval's
  version), `go mod tidy && go mod vendor`: works. Ten indirect modules come in (`invopop/jsonschema`,
  `tidwall/*`, `buger/jsonparser`, `pb33f/ordered-map`, `bahlo/generic-list-go`,
  `standard-webhooks`, `go.yaml.in/yaml/v4`, `golang.org/x/sync`). MVS picks `x/sync v0.16.0` here
  (the eval has `v0.23.0` because of its sqlite deps); harmless, the SDK needs no more.
  `go-sqlmock` moves from `// indirect` to a direct requirement (tidy notices the calculator tests).
- `vendor/`: 0.46 MB → 7.5 MB.
- Copied unit tests pass unchanged after the rewrite: `go test -mod=vendor ./ai/...` (detector,
  provider, vtt, ytdlp; transcript has none). `go vet` clean. The calculator unit tests pass with
  `go 1.27` in `go.mod`; CI already runs Go 1.27 (`setup-go`), so the bump changes no toolchain.
- Static binary (`CGO_ENABLED=0`, linux/amd64): `ai` 16.8 MB vs `calculate` 9.8 MB. In the arm64
  image: 15.7 MB vs 9.1 MB.
- **Image size delta: +22.5 MB** (423.5 MB → 446.0 MB, arm64): the `ai` binary (15.7 MB) plus
  the larger `vendor/` copied into the runtime stage by `COPY . .` (+7.3 MB; the runtime image
  does not need it, but `.dockerignore` cannot drop it without starving the `go-build` stage).
- **yt-dlp** (Task 2, not built here): the static `yt-dlp_linux` of release `2026.10.21` is 40.6 MB
  (`yt-dlp_linux_aarch64` 40.3 MB), `SHA2-256SUMS` is published with every release. Expected total
  image growth with Task 2 and 3 in: ≈ +63 MB (≈ 15% of today's image).

### Fact that changed the plan

The plan put the binary at `/app/prv/commands/ai` while its source lives in `prv/commands/ai/`
(`COPY . .` brings the directory into the runtime image), so a file cannot sit at that path. The
binary goes to `prv/commands/ai/ai` (next to its `main.go`, as `calculate` sits next to
`prv/commands/main.go`); the plan's cron lines now say `/app/prv/commands/ai/ai detect|judge`.

## Prod-host measurements (deferred)

Not run: the owner runs them from the prod host later (no install or cron on the host from the
plan run). Each one decides a constant that stays a placeholder until then.

| Spike | What it decides | Placeholder kept |
|---|---|---|
| `yt-dlp --list-subs` + `--write-auto-subs --sub-langs ru --skip-download`, 10 prv videos with known ru auto tracks, KZ IP, no cookies: success rate, wall time, rate limiting | whether the fetch works from prod at all, `AI_BATCH_MAX` / tick size | `AI_BATCH_MAX` 100, 3 yt-dlp attempts |
| Subtitle readiness: 10 videos published < 2 h ago, `--list-subs` hourly for 3 days (cron + log) | the no-track retry schedule | 6 h / 24 h / 72 h, then `no_track` |
| Views: the counter in the prv video page DOM the extension reads; `info.json` `view_count` for prv | the trigger and its fallback | `AI_MIN_VIEWS` 10000, `AI_FALLBACK_REQUESTS` 3 |
| (Task 9) whisper.cpp `small`, three 2-min windows on 5 audited videos | phase-3 cost and accuracy | timeline gate 3 s, binary |

## Constants (unchanged)

`AI_MIN_VIEWS` 10000 (owner 2026-10-22), `AI_FALLBACK_REQUESTS` 3, `AI_DAILY_BUDGET_VIDEOS` 200,
`AI_BATCH_MAX` 100, a batch result waited for at most 24 h (a constant, not an env variable), retry 6 h / 24 h / 72 h, timeline gate overrun > 3 s,
`AI_JUDGE_MIN_INTERVAL` 6 h.
