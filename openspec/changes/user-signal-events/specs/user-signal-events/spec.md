# Spec Delta

## Purpose

Collects the few viewer signals that tell whether a served segment was right (skipped and left alone, undone, or
overrun), from the extension to the provider's event tables, cheaply and in batches, so the product can analyse them
and later judge segments on them.

## ADDED Requirements

### Requirement: Every performed skip is reported
The client SHALL queue one `interval_skip` event per segment the player skipped, with `video_native_id`, `duration`
(whole seconds, when known), `category_id`, `start`, `end` and `via` = `auto` (the runner skipped it) or `suggested`
(the viewer took the "skip" action of a suggestion shown because auto-skip is off for the category).

#### Scenario: Automatic skip
- **WHEN** the runner seeks the player past one segment
- **THEN** one `interval_skip` event with that segment's bounds and `via: "auto"` is queued

#### Scenario: Bundle of contiguous segments
- **WHEN** the runner skips a bundle of three contiguous segments in one seek
- **THEN** three `interval_skip` events are queued, one per segment, each with its own bounds and category

#### Scenario: Suggestion taken
- **WHEN** auto-skip is off for the category, the suggestion is shown and the viewer presses "skip" (click or Enter)
- **THEN** one `interval_skip` event with the suggested segment's bounds and `via: "suggested"` is queued

#### Scenario: Suggestion ignored
- **WHEN** the suggestion is shown and the viewer does nothing
- **THEN** no event is queued

### Requirement: Every undo of a skip is reported
The client SHALL queue one `interval_undo` event when the viewer returns into a skipped segment: `via: "button"` for
the notification's "return" action (click or Enter), `via: "seek"` when the viewer seeks to a position inside a
segment skipped by the runner within the last 30 s; at most one undo per performed skip. The event carries the
segment's bounds and category (for a bundle: the first segment's, as the notification does) and `duration`.

#### Scenario: Return button
- **WHEN** the viewer presses the notification's "return" action after a skip
- **THEN** one `interval_undo` event with `via: "button"` is queued, and the runner does not skip the segment again

#### Scenario: Seek back
- **WHEN** 10 s after the runner skipped a segment the viewer drags the scrubber to a position inside that segment
- **THEN** one `interval_undo` event with `via: "seek"` is queued

#### Scenario: Seek back too late
- **WHEN** the viewer seeks into a segment the runner skipped 2 minutes earlier
- **THEN** no `interval_undo` event is queued

#### Scenario: One undo per skip
- **WHEN** the viewer presses "return" and then also seeks within the same segment
- **THEN** only the first `interval_undo` event is queued for that skip

### Requirement: A forward seek right after a skip is reported
The client SHALL queue one `interval_overrun` event when, within 10 s of wall-clock time after a runner skip landed at
a segment's end and before the player left the 10 s after that end, the viewer seeks forward by 3 to 120 s; the event
carries the landed segment's bounds and category (for a bundle: the last skipped segment's), `delta` (seconds
forward, whole) and `after` (seconds between the landing and the seek, whole); at most one per performed skip.

#### Scenario: Ad went on
- **WHEN** the runner lands at 70 s and 4 s later the viewer seeks to 95 s
- **THEN** one `interval_overrun` event with `start`/`end` of the landed segment, `delta: 25` and `after: 4` is queued

#### Scenario: Ordinary seek later
- **WHEN** the viewer seeks forward 30 s after the landing
- **THEN** no `interval_overrun` event is queued

#### Scenario: Seek back is not an overrun
- **WHEN** the viewer seeks backward right after the landing
- **THEN** no `interval_overrun` event is queued (the undo requirement decides whether it is an undo)

### Requirement: Events are sent in batches under the statistics switch
The client SHALL keep queued events in memory per page and send them as one `POST /events` array when the queue
reaches 20 events, once a minute while the queue is non-empty, and when the page is hidden or unloaded (a keep-alive
request); the queue holds at most 100 events, the oldest dropped first; a failed or interrupted send is not retried.
With the extension's statistics switch (`telemetryOptIn`) off, no event is queued.

#### Scenario: Idle viewer
- **WHEN** the viewer watches a 20-minute video with two skipped segments and no undo
- **THEN** at most two requests leave the page: the minute flush after the first skip and the one after the second
  (or one, when both fall into the same minute)

#### Scenario: Tab closed
- **WHEN** events are queued and the viewer closes the tab
- **THEN** the pending batch is handed to the browser as a keep-alive request and the page does not wait for it

#### Scenario: Switch off
- **WHEN** the viewer turned "Отправка статистики" off
- **THEN** skips, undos and overruns queue nothing, while votes and markups are still sent

#### Scenario: Nothing queued
- **WHEN** no event was queued since the last flush
- **THEN** no request is made

### Requirement: Each event identifies the viewer and the client
Every event in a batch SHALL carry `user_id` (the extension's generated id) and, on the main provider when known, the
platform account id under the wire field the client already uses for markups and votes; the client version goes with
the request as `v`.

#### Scenario: Main provider
- **WHEN** a signed-in viewer's event batch is sent on the main provider
- **THEN** every event has `user_id` and the platform account id field, which the API reads as `prv_user_id`

#### Scenario: Other providers
- **WHEN** a batch is sent on `/rt` or `/yt`
- **THEN** every event has `user_id` and no platform account id

### Requirement: The API stores the new event types
`POST /events` on every provider SHALL accept `interval_skip` (`via` in `auto` | `suggested`), `interval_undo` with
optional `via` in `button` | `seek`, and `interval_overrun` (`delta`, `after` integers ≥ 0), each with an optional
integer `duration`, and store each in its provider's `{provider}_events_<type>` table; the existing types keep their
behaviour.

#### Scenario: Mixed batch
- **WHEN** a batch holds two `interval_skip`, one `interval_undo` with `via: "seek"` and one `interval_overrun`
- **THEN** the four rows appear in their tables with `duration`, `via`, `delta` and `after` as sent, and the response
  is `200 { data: {} }`

#### Scenario: Old client
- **WHEN** a batch holds an `interval_undo` without `via` or `duration`
- **THEN** the row is stored with both NULL, as before this change

#### Scenario: Invalid via
- **WHEN** an `interval_skip` has `via: "manual"`
- **THEN** that event is logged and skipped and the other events of the batch are stored

#### Scenario: Other provider
- **WHEN** the batch is posted to `/yt/events`
- **THEN** the rows go to `yt_events_*`

### Requirement: A batch is bounded and stored in one statement per type
`POST /events` SHALL reject a body of more than 100 events with `413` and store nothing of it, and SHALL insert the
valid events of each type with one statement per type; the request does no other work on video, segment or user rows
(the `time_saved` handling is unchanged).

#### Scenario: Too many
- **WHEN** a batch holds 101 events
- **THEN** the response is `413` and no row is written

#### Scenario: Partial failure
- **WHEN** one type's insert fails
- **THEN** the other types' rows are still written, the failure is logged and the response is `200`
