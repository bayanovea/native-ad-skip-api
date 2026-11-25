# Proposal

From the owner's decisions of 2026-11-25 and 2026-11-26 after users reported that a new markup "is not added". No backlog item came before it; four items came out of it and stay open (see Out of scope).

## Why

On a video whose AI row is served, the AI entries replace the users' segments wholesale: a markup is saved, aggregated within a minute and then shown to nobody. On 2026-11-25 one user sent the same sponsor interval four times in nine minutes; 35 of the 105 markups of the last 10 days sit on such videos. The judge reads only markups made after publish and its LLM is told to answer `ok` when a markup only adds an ad, so no assessor ever sees the user's interval; intro and credits markups on these videos are served nowhere. The owner (2026-11-25): a live user markup is the most explicit signal that the model may have got the video wrong; (2026-11-26) the model reads subtitles and does not see the picture, so it is there to fill what users did not mark, not to correct what they did.

Prod, 2026-11-25: 3,936 served AI rows, 338 of them with user segments; 579 user sponsor / self_promotion segments on them, 167 covered by the served entries by less than half (113 videos); 131 intro and 10 credits segments on 125 videos, 15 of them overlapping a served entry.

## What Changes

- **A new pass `ai users`** (cron every minute, own lock and heartbeat `ai_users`, switch `AI_USER_SEGMENTS_ENABLED`, default `off`) writes the users' segments into the served AI row as entries with `source: "user"`. Nothing is merged on the read path: `data` stays exactly what is served.
- **A user ad segment that overlaps no served entry is shown at once** and gets one urgent ai review item (sheet `ai-user-<YYYY-MM-DD>`, codes `U<n>`). A keep makes the entry the reviewer's (`source: "review"`); `not_ad` / `unclear` hide it as `review` and it is never added again.
- **A short user addition is glued without an assessor**: when the segment overlaps or adjoins a served entry of its category and the union adds at most `AI_USER_GLUE_SECONDS` (default 20) to it, the row serves one entry at the union's bounds; the model's entry waits in `hidden` with the new reason `glued` and comes back when the user's segment goes.
- **A larger overlap waits for an assessor**: the AI entry stays served as it is and the segment gets a `U` item at the union's bounds, so a keep merges both by today's absorb rule.
- **User intro and credits segments are shown as they are** on AI-served videos (no item: the assessors' verdicts have no such category), unless they overlap a served entry.
- **Only new ad markups**: a sponsor / self_promotion segment is taken when one of its markups was created or edited at or after `AI_USER_SEGMENTS_SINCE`; the older queue stays out (owner, 2026-11-26: a blind test of 30 first).
- **Verdict application** learns the unverified entry: a keep elsewhere takes precedence over an overlapping `source: "user"` entry instead of failing with `bounds_overlap`; a row is withdrawn or restored by the model's and reviewers' entries alone.
- **The other writers leave user entries alone**: `ai regate`, the later second opinion, the served sample importer; the judge neither counts signals on them nor sends them to review, and a markup that became an entry is no conflict.
- **Switch off = today's behaviour**: with `AI_USER_SEGMENTS_ENABLED` off the tick removes every unverified user entry and puts the glued model entries back, then clears its heartbeat.
- **One page with every serving rule**: the AI-first overview (ru / en) opens with a table "situation → what the viewer gets", followed per rule by who decided it and when, its switch and where it lives (owner, 2026-11-26: the logic is no longer trivial and decisions will change).
- Dashboard: a row on user entries (shown, glued, held, `U` verdicts), the served-entry panels split by source; `/admin/video` shows a "user" badge and the `glued` reason.

## Capabilities

### New Capabilities
- `ai-user-segments`: users' segments on an AI-served video: which are taken, when one is shown at once, glued or held for an assessor, what its review item carries, how intro and credits are served, how the switch, the cut-off date and the glue limit gate it, and what the other AI writers must leave alone.

### Modified Capabilities
- `ai-verdict-application`: a verdict on a `source: "user"` entry (keep → the reviewer's, glued pieces follow the verdict), a keep overlapping an unverified user entry, withdraw and restore counting only the model's and reviewers' entries.

## Impact

- Go: `ai/pipeline/` (new `users.go`: candidates, clustering, classification, the row write, `U` items; `publish.go`: `reasonGlued`, `sourceUser`, `confidence` omitted when empty; `regate.go` `place()`; `backlog.go`; `detect.go` `Config`), `ai/judge/` (`signals.go`, `judge.go`: own entries vs served entries), `prv/commands/ai/main.go` (`ai users`), `crontab`.
- Node: `prv/repository/ai.js` (`applyVerdict`, `allKept`, `sendToReview` text), `lib/ai-rules.js` (`HIDDEN_REASONS.GLUED`), `prv/routes/admin.js` (badge), `scripts/import-below-threshold.js` (`--served` leaves user entries out). No schema change: no table, no column.
- Ops: `docker-compose.yml`, `.github/workflows/deploy.yml` (both lists), `grafana/dashboards/ai-pipeline.json`, `grafana/dashboards/infrastructure.json`, `grafana/provisioning/alerting/rules.yml` (the heartbeat's limit).
- The extension needs no change: it reads `category_id`, `start`, `end`, `rating` and ignores `source` / `confidence`.
- Tests: Go unit tests under `ai/pipeline` and `ai/judge`, `test/e2e.js` (`ai users:`), fixtures with placeholder ids.
- Behaviour with the switch on: about 141 intro / credits segments return on about 125 videos at once; new ad markups on AI-served videos are served within two minutes; about 2 `U` items a day. No change with the switch off.

## Out of scope

- The old queue (ad segments from markups before `AI_USER_SEGMENTS_SINCE`) and adopting the keeps of sheet `sample-2026-11-26`: `docs/backlog/ai-uncovered-user-segments-queue.md`, after the blind test.
- A user segment the served entries cover by half or more whose edges differ: the AI's edges stay (`docs/backlog/ai-user-edge-disagreement-untested.md`); a user segment never trims an AI entry.
- Deciding the glue by what the subtitles say over the added stretch (`docs/backlog/ai-user-glue-by-subtitle-meaning.md`).
- The extension keeping the author's own segment on screen (`docs/backlog/client-own-markup-on-ai-videos.md`): right after this change.
- A cap on the length of a segment shown at once, and any effect of a `not_ad` on the author's rating or on the human path (the segment is served again once the AI row is withdrawn).
- Rows with an empty `data` or withdrawn: the human path serves those videos already.
- `rt` / `yt`: no AI rows there.
