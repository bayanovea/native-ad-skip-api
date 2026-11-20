# Design

## Context

See proposal.md for the why. State on 2026-11-20 (prod read-only, client v2.3.0):

- `POST /events` (`prv/routes/events.js`, since 2026-05-05, shared by the three providers) validates each event,
  inserts row by row in a `Promise.all`, returns `200 { data }`. Tables `{provider}_events_interval_undo` /
  `_interval_click` / `_time_saved` / `_client_failed`: 0 rows each on prod. `legacyField()` already copies the
  client's wire field to `prv_user_id` in every element of the array.
- The judge (`ai/judge/signals.go`) counts `undo` and `clicks` on the entries' exact bounds by `video_native_id`;
  `rules.go` sends any new `votes_down` / `undo` / conflicting markup to the LLM. 3,601 judgements since 10-28: 12 with
  `votes_down > 0`, 0 with `undo > 0`.
- Volumes: ~22,000 `GET /video-calculated` a day; votes 2–18 a day. Skips will be the most frequent event: a few
  thousand a day at most (one per served segment per view that reaches it).
- Client: `core/events/bus.ts` already emits `segment/skipped`, `segment/skipped-multiple`, `segment/skip-suggested`;
  the notification's "return" (`rewindToStart`) and "skip" (`skipToEnd`) live in
  `ui/components/notifications-bar/notificationsController.ts`; the runner (`core/segments/segment-runner.ts`) holds
  the `<video>` element and dedupes a skip by bundle key, so an undone segment is not re-skipped. `apiFetch`
  (`shared/api/http.ts`) merges the platform context into an object body; `telemetryOptIn` exists in settings and the
  settings modal and is read by nothing.

## Goals / Non-Goals

**Goals:**
- Request-time work on the API is validation and inserts; every aggregation runs in cron or at view time.
- With `AI_JUDGE_UNDO_EVIDENCE` unset, the judge behaves exactly as today (the e2e suite without the variable proves it).
- The client sends nothing a viewer would notice: one request a minute at most while skipping, none while idle.

**Non-Goals:**
- Exact delivery: a batch lost on tab close or network failure is not retried (owner, 2026-11-20).
- Telling the client whether a segment is AI or human: the server joins events to entries by bounds.

## Decisions

1. **Three events, not a generic telemetry stream.** `interval_skip`, `interval_undo` (extended), `interval_overrun`
   (owner, 2026-11-20: only potentially needed signals). `time_saved` is derived (`SUM(end − start)` over skips minus
   undone ones), so the client stops carrying it and the `time_saved` branch of the route stays for old clients.
   `interval_click` has no source in v2 and is left as is. Alternative: one `events` table with a JSONB payload —
   rejected, the judge and the panels join on typed bounds columns and the existing tables are already per type.

2. **Skip rows are the denominator.** A skip followed by no undo is the positive signal; undo / skips is the rate the
   judge and the panels use (per 1000 views stays as the fallback for old rows). The skip event is emitted at the
   moment of the skip, the undo as a separate row when it happens: one row per fact, no delayed "outcome" event that
   would need the client to wait out the undo window before sending.

3. **Undo by seek and overrun are detected in the runner.** It has the `<video>` element and the last bundle: on
   `seeking`, with `lastSkip = {segments, landedAt (video time), at (wall clock)}`, a target inside a skipped segment
   within 30 s → undo via `seek` (first segment's bounds, as the notification votes); a target 3–120 s ahead of the
   current position within 10 s of the landing while the position is still within 10 s after the landed end → overrun
   (last segment's bounds, `delta`, `after`). One undo and one overrun per `lastSkip`; the button undo marks the
   `lastSkip` too, so a seek after it adds nothing. The notification controller emits bus events (`segment/undo`
   via `button`, `segment/suggestion-taken`) instead of knowing about telemetry. Alternative: watch `seeking` in the
   notification UI — rejected, the UI lives only while the toast is shown.

4. **Queue in the content script, flush with keep-alive fetch.** `core/telemetry/`: a bus subscriber maps events to
   DTOs, a queue (max 100, oldest dropped) flushes at 20, on a 60 s timer armed when the queue becomes non-empty, and
   on `visibilitychange: hidden` / `pagehide` with `fetch(…, { keepalive: true })` (JSON body ≤ 64 KB, survives
   unload in Chrome and Firefox ≥ 133; `sendBeacon` would force `text/plain` or a preflight). The subscriber is not
   attached when `telemetryOptIn` is off and detaches when it turns off (settings change listener); the queue is
   dropped then. Alternative: relay through the background script — rejected, the content script already makes every
   other request and a page lifetime is the natural batch boundary.

5. **Array body bypasses the context merge.** The events endpoint uses `contextPlacement: 'query'`, so `v` and the
   platform account id go to the query string and the array body stays an array; every event carries `user_id` and the
   platform account id itself (built by `shared/api/events.ts` from the same services `applyApiContext` reads). The
   server reads the per-event fields as today.

6. **Bulk insert, batch cap, indexes.** The route groups valid events by type and calls `bulkCreate` once per type
   (one failure logs and loses that type only, as the per-row `tryHandle` does today); a body of more than 100 events
   is `413` before validation (`bodyParser.json`'s 100 KB limit stays). New tables get `(video_native_id, category_id,
   start, "end")` and `("createdAt")` indexes in the model; the existing undo tables get the same via
   `CREATE INDEX IF NOT EXISTS` in `syncSchema()` for the three prefixes, plus `ADD COLUMN IF NOT EXISTS via TEXT,
   duration INTEGER`. `duration` is stored, not joined: the judge keeps joining by `native_id` and bounds (a re-cut has
   different bounds), the panels and the analysis use it to attribute to a `videos` row.

7. **`AI_JUDGE_UNDO_EVIDENCE` (default on) rather than a code change to the rules.** The e2e judge tests and the live
   behaviour since 10-28 rest on undo as evidence; the owner wants undo collected but not acted on in this iteration
   (owner, 2026-11-20). A switch keeps "off = today" out of the picture: unset is today's behaviour, the owner sets
   `off` with this deploy, and turning undo back on later is an env change, not a release. Off: `Evidence.negative()`
   ignores `Undo`; the due query (`signals.New` filter) ignores undo rows likewise, so such videos are not even read;
   `rules()` returns `ok` with the reason in the spec. Same style as `AI_JUDGE_AUTO_WITHDRAW` (a default-on judge
   switch). `skips` enters `Counters`, `Signals` and the LLM request (`undo: 2 (2 per 40 skips, 0.4 per 1000 views)`),
   and the prompt's `<signals>` legend names it.

8. **Precision-first.** This change serves nothing new: the intake writes event tables only, and the switch can only
   reduce the judge's actions (fewer LLM calls, no undo-only withdraws). A wrong segment that viewers undo is still
   caught by down votes, conflicting markups and the assessors; the undo evidence returns when the owner sets the
   switch back on.

9. **Locks and transactions.** The events route takes no row lock and no transaction: three independent inserts.
   The judge's reads are unchanged (one query per signal, outside its write transaction). No change touches
   `video_calculateds`, the AI row or review batch rows.

10. **Rollback.** The previous image: `interval_skip` / `interval_overrun` events are "unknown event type", logged and
    skipped; `interval_undo` rows are inserted without `via` / `duration` (nullable columns); the new tables are
    ignored; the previous `ai` binary ignores `AI_JUDGE_UNDO_EVIDENCE` and `skips`, so undo becomes evidence again
    (the owner's switch has no effect on that image). No data needs to be removed.

## Risks / Trade-offs

- [Undo via seek over-counts: a viewer rewinding for an unrelated reason into a 60 s segment within 30 s] → the window
  is short, the rate is read against skips, and the signal is data only while the switch is off; the window is a
  constant to tune after the first month.
- [Overrun is noisy: viewers skip boring content too] → collected for analysis only; not in the judge.
- [Event tables grow without bound: ~5,000 rows a day ≈ 2 M rows, ~0.4 GB a year with indexes] → backlog item for
  retention (drop skip rows older than N months once the judge has what it needs).
- [A client version shipped before the API deploy sends events the old route rejects] → the API deploys first; the
  extension release follows (its store review takes days anyway).
- [Keep-alive fetch unsupported on an old Firefox] → the hidden-tab flush is lost there; the minute flush still works.
- [One user can post many events] → same exposure as votes today; the batch cap bounds a request; abuse is visible
  per `user_id` in the panels.

## Open Questions

- The seek windows (30 s undo, 10 s / 3–120 s overrun) and the queue parameters (20, 60 s, 100) are constants chosen
  without data; revisit after the first analysis. They change no spec text beyond the numbers.
