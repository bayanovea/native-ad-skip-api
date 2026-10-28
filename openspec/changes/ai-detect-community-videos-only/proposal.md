# Proposal

## Why

A prv video id has the form `<owner>_<video>`: a negative owner (`-111_222`) is a community (group or channel), a positive one (`111_222`) is a personal user upload. The owner's view: user uploads are not where integrated ads live, so spending detector calls on them wastes the daily budget, which the views / requests thresholds of `ai-detect-trigger-views-or-requests` are meant to control.

No backlog item.

## What Changes

- **Queue rule**: the scheduled `ai detect` tick takes only videos whose `native_id` starts with `-`, on top of the views / requests criteria; a user upload never leaves the queue on its own, whatever its views or requests. This applies to every queue branch (`seen`, a due retry, a stale `fetching`), so a user upload already waiting for a retry stops there too.
- **Unchanged**: the read path keeps recording user uploads in `prv_ai_videos` (counts stay visible, and a later rule change needs no history); the manual run `ai detect <native_id>` still takes a user upload (an operator's explicit choice, like it already ignores views and budget); rows already detected (published, withdrawn) keep being served and judged.
- **Dashboard** (`ai-pipeline.json`): a new funnel stage "0. Видео пользователя (id без «-»): AI не запускаем" for user uploads in `seen` / `queued` / `fetching`; the stage-1, stage-2 and retry panels (18, 19, 21, 24, 27, 30) leave them out, so their counts mean what they say.
- **Docs**: CLAUDE.md (Trigger, `ai detect` claim rule, Dashboard funnel), the ru/en AI-first overview pages and their artifacts.

Out of scope: an env switch for this rule (it is a fixed product rule, not a spend knob), withdrawing already-published user uploads, stopping the read-path upsert.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `ai-detect-queue`: adds the community-only requirement. The capability is introduced by `ai-detect-trigger-views-or-requests`, which is archived first; this delta only adds a requirement.

## Impact

- Go: `ai/pipeline/queue.go` (queue rule), `ai/pipeline/queue_test.go`.
- e2e: `test/e2e.js` `ai detect:` case with a positive-id row past both thresholds.
- Ops: `grafana/dashboards/ai-pipeline.json`.
- Docs: `CLAUDE.md`, `docs/ai-first-overview/{ru,en}.html`.
- Prod data: positive-id rows in `seen` / `queued` stay where they are; nothing is rewritten.
