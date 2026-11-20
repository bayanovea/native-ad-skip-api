# Proposal

## Why

The product has judged its segments on viewer signals since 2026-10-28, but the only signals that ever arrive are
votes (2–18 a day, 0–2 of them down) and human markups: `POST /events` and the `{provider}_events_*` tables have
existed since 2026-05-05 and hold 0 rows on prod, because the extension (v2.3) never calls them. The judge's `undo`
signal is therefore always 0, and nothing records how often a served segment is skipped at all, so even a real undo
would have no denominator. Before the product can decide what to re-mark or send to assessors, it needs the few signals
that carry that information, collected for a while and analysed.

## What Changes

- The extension sends three passive signals in batches: every skip the player performed (`interval_skip`, with
  whether it was automatic or taken from a suggestion), every undo of a skip (`interval_undo`, by the notification
  button or by a seek back into the skipped segment), and a forward seek right after a skip landed
  (`interval_overrun`: the ad went on past the segment's end). Each event carries the video's `duration` next to its
  `native_id`, so it attributes to the right cut. Batches flush once a minute while something is queued, at 20
  events, and on tab hide with a keep-alive request; a lost batch is accepted.
- The passive signals obey the extension's existing "Отправка статистики" switch (`telemetryOptIn`, default on,
  today read by nothing); votes and markups are explicit actions and stay outside it.
- `POST /events` accepts the two new types and the new fields, inserts each type in one statement, and caps a batch
  at 100 events; the two new tables and the undo table get indexes on the bounds and on time. Nothing else happens at
  request time: analysis is SQL (Grafana panels on `product-stats` and `ai-pipeline`) and the judge's cron.
- The judge counts skips next to undo (the rate per skip is the measure, not per 1000 views alone) and, with the new
  `AI_JUDGE_UNDO_EVIDENCE` switch off, no longer treats an undo as the new evidence that makes a video due: undo is
  recorded and shown when something else triggers the judge, but alone triggers no LLM call, no review item, no
  withdraw (owner, 2026-11-20: collect first, act in the next iteration). Default on = today's behaviour.
- Not sent: `time_saved` (derivable from the skip rows), `interval_click` (the v2 client has no segment list; the table
  stays), `client_failed` (not a markup signal).

## Out of scope

- Acting on the signals: thresholds, re-marking, automatic review items from undo rates, a queue or worker. The owner
  runs SQL and the panels by hand; the strategy follows the data (owner, 2026-11-20).
- More telemetry: pauses, playback rate, sessions, watch completion, UI attach failures (the client's own p2).
- Retention of the event tables: filed as a backlog item with a size estimate; no job in this change.
- The eval repo: it uses no viewer signals; field precision from undo rates is a later eval-side idea.
- Firefox `data_collection_permissions`: the client's backlog item `vk-firefox-data-consent.md` gets a note that the
  new events fall under the categories it already lists; the key itself is that item's work.

Comes from `docs/backlog/client-events-never-arrive.md` (closed by this change: rows arrive, and `clicks` is kept
only as a counter) and the client's `TODO.md` p0 lines "отправлять события skip/skip-multiple/undo на сервер" and
"time-saved отправлять/получать с бэкенда" (the second resolved by derivation).

## Capabilities

### New Capabilities
- `user-signal-events`: the viewer-signal intake: which events the client emits and when, their fields, batching and
  opt-in, what `POST /events` accepts, validates and stores, and the limits on a batch.
- `ai-judge-evidence`: which stored signals the judge counts and which of them make a judged video due again,
  including the `AI_JUDGE_UNDO_EVIDENCE` switch and the skip counter.

### Modified Capabilities
- none (the judge had no spec; its behaviour is in `docs/reference/ai-first.md`).

## Impact

- API: `prv/routes/events.js` (types, validation, bulk insert, batch cap), `prv/db/index.js` (`IntervalSkip`,
  `IntervalOverrun` models, undo `via` / `duration`), `lib/schema.js` (ALTERs and indexes on the existing undo
  tables of the three providers), `api/doc/openapi.yaml` (three `/events` entries), `test/e2e.js`.
- Judge: `ai/judge/signals.go` (`skips`, `undo` by any `via`), `rules.go` (`Evidence.negative()` under the switch),
  `llm.go` / `ai/prompts/judge-v1.md` (skips in `<signals>`), `prv/commands/ai/main.go` (the switch), e2e judge
  tests, `docker-compose.yml` and both lists in `.github/workflows/deploy.yml`.
- Dashboards: `grafana/dashboards/product-stats.json` (skips, undo and overrun per day), `ai-pipeline.json` (undo rate
  on AI entries vs human segments, top videos by undo rate).
- Client (`~/Web/vk-ad-skip-v2`, its own commits): `shared/api/{endpoints,events,types}.ts`, a new `core/telemetry/`
  (queue, flush, the bus-to-event mapping), `core/segments/segment-runner.ts` (seek listener), the notifications
  controller (undo and suggestion-taken bus events), `entrypoints/content/index.ts`, guidance files, `TODO.md`,
  `CHANGELOG.md`.
- Docs: CLAUDE.md (Routes, Models, Environment Variables, AI-first), `docs/reference/{routes,models,ai-first,metrics}.md`,
  `docs/ai-first-overview/{ru,en}.html` if they name undo as a judge trigger.
