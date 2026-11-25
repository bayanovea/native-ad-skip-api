# Spec Delta

## Purpose

Defines how users' own segments reach viewers on a video whose AI row is served: which segments are taken, when one is shown at once, glued to an AI entry or held for an assessor, how intro and credits are served, and what the switch and the other AI writers do with such entries.

## ADDED Requirements

### Requirement: User segments are off unless switched on
The `ai users` tick SHALL write user entries and review items only with `AI_USER_SEGMENTS_ENABLED=on`. Switched on, it requires `AI_USER_SEGMENTS_SINCE` (an RFC 3339 instant or a `YYYY-MM-DD` date, UTC) and reads `AI_USER_GLUE_SECONDS` (integer ≥ 0, default 20); a missing or invalid value is a startup error naming the variable, with nothing written.

#### Scenario: Default
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is unset and a user posts a sponsor markup on an AI-served video
- **THEN** the AI row is unchanged, no review item is created and the tick leaves no `ai_users` heartbeat

#### Scenario: Switched on without the cut-off
- **WHEN** `AI_USER_SEGMENTS_ENABLED=on` and `AI_USER_SEGMENTS_SINCE` is unset or not a date
- **THEN** the tick exits 1 naming `AI_USER_SEGMENTS_SINCE` and changes no row

#### Scenario: Invalid glue limit
- **WHEN** `AI_USER_GLUE_SECONDS=abc`
- **THEN** the tick exits 1 naming `AI_USER_GLUE_SECONDS`

### Requirement: Switching off restores today's serving
With `AI_USER_SEGMENTS_ENABLED` not `on`, a tick SHALL remove every entry with `source: "user"` from every AI row and serve the model's entries hidden as `glued` again, so that within one tick viewers get what they got before the switch. Entries a verdict made the reviewer's stay.

#### Scenario: Off after a day on
- **WHEN** a row serves a model entry glued with a user segment, a standalone user entry and a kept former user entry (`source: "review"`), and the switch goes off
- **THEN** after one tick the row serves the model entry at its own bounds and the kept entry, the standalone user entry is gone, and no entry has the reason `glued`

### Requirement: Only rows that serve the model's own entries are handled
The tick SHALL add user entries only to an AI row that is not withdrawn and serves at least one entry that is not a user entry, counting a model entry hidden as `glued` as served. On any other row it SHALL leave no user entry, so the human path keeps serving that video.

#### Scenario: Withdrawn row
- **WHEN** the AI row is withdrawn and a user posts a markup on the video
- **THEN** the row is unchanged and `GET /video-calculated` serves the human segments

#### Scenario: Every model entry hidden on review
- **WHEN** a row's only model entry is hidden by a `not_ad` while a user entry is served
- **THEN** the row is withdrawn by review as today, and the human path serves the video

#### Scenario: Switch off
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is off
- **THEN** no row gets a user entry

### Requirement: Near-duplicate user segments count once
User segments of one category on a video that overlap each other with IoU ≥ 0.5 SHALL be treated as one segment at the bounds of the one with the most authors (then the best author rating, then the newest markup), carrying the authors and the newest markup of all of them.

#### Scenario: Two buckets, one ad
- **WHEN** the video has sponsor segments 571–722 (3 authors) and 573–728 (2 authors)
- **THEN** one user segment 571–722 is considered, and at most one entry and one review item come of it

### Requirement: An ad segment is taken only when new, long enough and from an author in good standing
A sponsor or self_promotion user segment SHALL be considered only when its best author rating is ≥ 0, its length is at least `AI_MIN_SEGMENT_SECONDS` and one of its markups was created, or had an interval edited, at or after `AI_USER_SEGMENTS_SINCE`.

#### Scenario: Old markup
- **WHEN** every markup of a sponsor segment predates `AI_USER_SEGMENTS_SINCE`
- **THEN** the segment gives no entry and no review item

#### Scenario: Edited old markup
- **WHEN** an old markup's interval is edited after `AI_USER_SEGMENTS_SINCE`
- **THEN** its segment is considered

#### Scenario: Author rated down
- **WHEN** the only author of a new sponsor segment has rating −1
- **THEN** the segment gives no entry and no review item

#### Scenario: Switch off
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is off
- **THEN** no segment is considered, whatever its date

### Requirement: A segment the served entries mostly cover changes nothing
A considered ad segment that the row's served entries, user entries aside, cover by half of its length or more SHALL give no entry and no review item: the AI's edges stay.

#### Scenario: Same ad, other edges
- **WHEN** the row serves sponsor 219–292 and a user marks sponsor 225–300
- **THEN** the row still serves sponsor 219–292 only and no item is created

### Requirement: A segment that overlaps no served entry is shown at once
A considered ad segment that overlaps no served entry and is not glued SHALL be added to `data` at its bounds with its category, `source: "user"`, no `confidence` and the rating of the votes on those bounds, and SHALL get one review item. It is served from that tick until a verdict decides it.

#### Scenario: A missed ad far from the AI's
- **WHEN** the row serves sponsor 219–292 and a user in good standing marks sponsor 1453–1490 after the cut-off
- **THEN** within the next tick `GET /video-calculated` returns both segments, the new one with `source: "user"`, and an open `U` item exists on 1453–1490

#### Scenario: Votes on it
- **WHEN** a viewer votes on the user entry
- **THEN** the vote is accepted, the entry's rating and the human segment's on the same bounds change alike, and the authors are rated as on the human path

#### Scenario: Switch off
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is off
- **THEN** the response has the AI entries only, as today

### Requirement: A short addition is glued to the AI entry
A considered ad segment that overlaps a served model entry of its category, or lies within `AI_USER_GLUE_SECONDS` of one, SHALL be glued when the union of the segment and those entries is at most `AI_USER_GLUE_SECONDS` longer than the entries together and overlaps nothing else served: the row serves one entry at the union's bounds (`source: "user"`), the model's entries move to `hidden` with reason `glued`, and no review item is created.

#### Scenario: A tail the model missed
- **WHEN** the row serves sponsor 219–292, `AI_USER_GLUE_SECONDS` is 20 and a user marks sponsor 290–308
- **THEN** the row serves sponsor 219–308 (`source: "user"`), hides sponsor 219–292 as `glued`, and no `U` item exists

#### Scenario: A small gap
- **WHEN** the row serves sponsor 219–292 and a user marks sponsor 295–310
- **THEN** the row serves sponsor 219–310: the 18 added seconds include the gap

#### Scenario: Another category is never glued
- **WHEN** the row serves self_promotion 219–292 and a user marks sponsor 292–308
- **THEN** nothing is glued and the segment is shown on its own with a `U` item

#### Scenario: Limit zero
- **WHEN** `AI_USER_GLUE_SECONDS=0`
- **THEN** nothing is ever glued

#### Scenario: Switch off
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is off
- **THEN** the row serves sponsor 219–292 as today

### Requirement: An entry an assessor confirmed is never glued
A served entry whose latest ai-item verdict is a keep, or whose `source` is `review`, SHALL not be glued: a segment that would extend it is held for an assessor instead.

#### Scenario: Kept entry, short tail
- **WHEN** the row serves sponsor 219–292 with a keep verdict and a user marks sponsor 290–308
- **THEN** the row still serves 219–292 and a `U` item exists on 219–308

#### Scenario: A keep arrives while glued
- **WHEN** a keep is saved on the item of a model entry that is hidden as `glued`
- **THEN** on the next tick the model entry is served at its own bounds again, the glued entry is gone and the user's segment has a `U` item

### Requirement: A glue follows the user's segment
A glued entry SHALL exist only while its segment still qualifies. When the segment is deleted, moves so that the rule no longer holds, or the model's entry is hidden on review, the tick SHALL remove the glued entry and serve the model's entries hidden as `glued` at their own bounds again, with the rating of the votes on them, unless a served entry overlaps them.

#### Scenario: The user deletes the markup
- **WHEN** the row serves the glued sponsor 219–308 and the user deletes the markup
- **THEN** on the next tick the row serves sponsor 219–292 with `source: "ai"` and no entry has the reason `glued`

### Requirement: A larger overlap is held for an assessor
A considered ad segment that overlaps a served entry, is not mostly covered and is not glued SHALL leave `data` unchanged and get one review item at the union of the segment and the served entries of its category it overlaps (at the segment's own bounds when it overlaps only entries of another category).

#### Scenario: The user's ad is much longer
- **WHEN** the row serves sponsor 17–24 and a user marks sponsor 0–55
- **THEN** the row still serves sponsor 17–24 only, and an open `U` item exists on 0–55

#### Scenario: Partial overlap
- **WHEN** the row serves sponsor 219–292 and a user marks sponsor 285–334
- **THEN** the item's bounds are 219–334, so that a keep without bounds merges both by the absorb rule

#### Scenario: Another category underneath
- **WHEN** the row serves self_promotion 357–370 and a user marks sponsor 360–437
- **THEN** the row is unchanged and the item's bounds are 360–437

#### Scenario: Switch off
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is off
- **THEN** no item is created

### Requirement: A user segment's review item
The item SHALL be a `kind = 'ai'` item on the AI row in sheet `ai-user-<YYYY-MM-DD>` (UTC) with code `U<n>`, priority `urgent`, placed like the judge's items (never into a part someone holds or has a verdict in), `proposed` = the segment's category, the run's transcript over its bounds, the player link 2 s before its start, and `flagged_by` naming the authors' count, the best rating, and whether the segment is shown or held and what it overlaps.

#### Scenario: Blind until decided
- **WHEN** an assessor opens an undecided `U` item
- **THEN** the page shows the stretch, the transcript and the row's other served entries, and not `flagged_by`

#### Scenario: One item per segment
- **WHEN** ticks run again while the `U` item of a segment is undecided, or a second user adds a markup that shifts the segment by a second
- **THEN** no further item is created for it

### Requirement: A verdict closes the segment
A user segment that has a decided `U` item on its stretch (IoU ≥ 0.5 between the item's own bounds and the bounds the segment would be sent at), or that overlaps with IoU ≥ 0.5 any item of the video whose latest verdict is `not_ad` or `unclear`, SHALL give no entry and no new item.

#### Scenario: Not an ad
- **WHEN** an assessor answers `not_ad` on the `U` item of a shown segment
- **THEN** the entry is hidden as `review`, and later ticks neither serve it nor create another item while the markup stays

#### Scenario: The model's entry there was already rejected
- **WHEN** an entry hidden by a `not_ad` sits at 100–130 and a user marks sponsor 98–131
- **THEN** the segment gives no entry and no item

#### Scenario: Kept at smaller bounds
- **WHEN** an assessor keeps the `U` item of segment 0–960 with bounds 100–160
- **THEN** the row serves 100–160 (`source: "review"`), and later ticks create no second item for 0–960

### Requirement: An unverified entry follows its segment
A `source: "user"` entry SHALL be removed by the tick when no considered segment matches it any more (the markup was deleted, or edited to another stretch, or its author's rating fell below 0) or when the rules no longer place it. While its item is undecided and a segment still matches the item (IoU ≥ 0.5), the entry stays at the item's bounds.

#### Scenario: The author deletes the markup before a verdict
- **WHEN** a shown segment's only markup is deleted
- **THEN** on the next tick the entry is gone; the open item stays and a later keep on it serves the stretch as the reviewer's entry

### Requirement: User intro and credits are shown as they are
On a handled row, every intro and credits user segment with a best author rating ≥ 0 (near-duplicates counted once) SHALL be served as an entry with `source: "user"` and the rating of the votes on its bounds, whatever its age or length, unless it overlaps a served entry. Such an entry gets no review item.

#### Scenario: An intro on an AI-served video
- **WHEN** the row serves sponsor 219–292 and the video has a user intro 0–20 from last year
- **THEN** `GET /video-calculated` returns both, and no review item is created for the intro

#### Scenario: An intro over an AI entry
- **WHEN** the row serves sponsor 10–40 and a user intro is 0–30
- **THEN** the intro is not served

#### Scenario: Switch off
- **WHEN** `AI_USER_SEGMENTS_ENABLED` is off
- **THEN** the intro is not served on that video, as today

### Requirement: Served entries never overlap
The tick SHALL never write a `data` in which two entries overlap: of two user segments that overlap each other, the one with more authors (then the better rating, then the newer markup) is placed and the other waits without an item.

#### Scenario: Two users, two categories, one stretch
- **WHEN** one user marks sponsor 100–160 and another self_promotion 120–180, both new, far from every AI entry
- **THEN** one of them is served with its item and the other gives neither an entry nor an item

### Requirement: Other writers leave user entries alone
`ai regate` SHALL move neither a `source: "user"` entry nor an entry hidden as `glued`; the later second opinion SHALL never hide a user entry as `unconfirmed`; the served sample of the below-threshold importer SHALL never pick one.

#### Scenario: Regate after a threshold change
- **WHEN** `ai regate` runs on a row that serves a user entry and hides a `glued` model entry
- **THEN** both stay where they are

#### Scenario: A later second opinion
- **WHEN** the backlog pass confirms a row whose user entry overlaps a first-model segment the second model did not find
- **THEN** the user entry stays served

### Requirement: The judge judges the model's entries only
`ai judge` SHALL count votes and events, ask the LLM about and send to review only the row's entries that are not user entries, and SHALL skip a row that serves no other entry. A human markup with IoU ≥ 0.5 to a served user entry of its category is no conflicting markup.

#### Scenario: A dislike on a user entry
- **WHEN** a viewer votes down a `source: "user"` entry on an otherwise quiet row
- **THEN** the judge records no new evidence, calls no LLM and creates no item for it

#### Scenario: The markup behind a shown entry
- **WHEN** a user's sponsor markup is served as a user entry
- **THEN** the judge's `conflicting_markups` does not count it

### Requirement: User segments are visible to the operator
The tick SHALL write the `ai_users` heartbeat (failed rows counted, a success when its own queries ran) and one log line per changed row and per tick; `/admin/video/:video_id` SHALL mark a `source: "user"` entry and show the `glued` reason; the AI dashboard SHALL show the user entries served now by kind, the glued entries, the open `U` items and their verdicts, and SHALL not count user entries as the model's.

#### Scenario: Heartbeat
- **WHEN** a tick runs with the switch on
- **THEN** `/metrics` carries `calculator_last_success_timestamp_seconds{provider="ai_users"}`

#### Scenario: Switch off
- **WHEN** the switch is off
- **THEN** the tick deletes its heartbeat row, so the stale alert stays quiet
