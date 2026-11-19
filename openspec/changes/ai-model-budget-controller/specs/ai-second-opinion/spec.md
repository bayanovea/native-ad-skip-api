# Spec Delta

## MODIFIED Requirements

### Requirement: Every answered video gets one second-model call
With `AI_SECOND_ENABLED` on, after the first model's answer validates, the system SHALL make one synchronous call to the second model with the same prompt text, the same transcript rendering and the same output schema, on the cron tick and in the manual run alike, and SHALL validate the answer against the transcript as the first one is. With `AI_BUDGET_ENABLED` on and the second model's vendor's cap for today spent, the cron tick SHALL instead publish the video from the first answer alone and leave it for the confirmation backlog.

#### Scenario: Switched off
- **WHEN** `AI_SECOND_ENABLED` is unset or `off`
- **THEN** no second-model call is made

#### Scenario: Batch answer resolved on a tick
- **WHEN** a batch ends with answers for three videos
- **THEN** each video gets its own second call before it is published, and the tick's own duration grows by those calls

#### Scenario: Manual run
- **WHEN** `ai detect <native_id>` gets the first answer
- **THEN** the second call is made in the same run and the video's outcome reflects it, whatever the budget says

#### Scenario: Nothing to confirm
- **WHEN** the first model returned no segments
- **THEN** the second call is still made and recorded (its segments are the measurement), and the row is published with empty `data` as today

#### Scenario: Second model's cap spent
- **WHEN** `AI_BUDGET_ENABLED` is `on`, Anthropic is the second model's vendor and its spend today has reached its cap when a batch answer arrives
- **THEN** the video is published with every first-model segment that passes the confidence and length rules served, no confirmation row is written, and the row counts in the confirmation backlog

#### Scenario: Budget off
- **WHEN** `AI_BUDGET_ENABLED` is unset or `off`
- **THEN** every answered video gets its second call as today, whatever was spent

### Requirement: The dashboard shows the second opinion
The AI dashboard SHALL count `unconfirmed` entries in the hidden-by-reason panel and SHALL show, from the confirmation rows, the calls per day, the share of first-model segments confirmed, the failures with their reasons, the second-model-only segments and the cost. The failure reasons SHALL read the same for either vendor's error texts. It SHALL show the confirmation backlog (rows waiting, the oldest one's age, rows confirmed later per day) and, per detector → second model pair, the signals already collected: rows, served entries per row, unconfirmed share, `D` verdicts `not_ad` / `unclear` among decided, judge `review` / `withdraw` per 100 rows and −1 votes per 100 served entries.

#### Scenario: Panels read the rows
- **WHEN** confirmation rows exist
- **THEN** the second-opinion row of the dashboard shows their counts, and the hidden-by-reason panel has an `unconfirmed` column

#### Scenario: An exhausted account of either vendor
- **WHEN** one confirmation row carries OpenAI's `insufficient_quota` and another Anthropic's `credit balance is too low`
- **THEN** the failure reasons panel counts both as the account's budget running out

#### Scenario: Anthropic overloaded
- **WHEN** a confirmation row carries Anthropic's `529` `overloaded_error`
- **THEN** the failure reasons panel counts it as an API failure or timeout

#### Scenario: Backlog
- **WHEN** 4,000 rows wait for a confirmation and 600 were confirmed later yesterday
- **THEN** the backlog panels show 4,000 waiting, the oldest one's age and 600 for yesterday

#### Scenario: Pairs side by side
- **WHEN** rows exist from Sonnet → luna, from terra → Haiku and from terra alone
- **THEN** the pair table has one line per pair, the detector-alone rows on their own line, with no new review item created for the table

## ADDED Requirements

### Requirement: Published rows without a confirmation are confirmed later
With `AI_SECOND_ENABLED` and `AI_BUDGET_ENABLED` on, each detect tick, after resolving its batches, SHALL make second calls for published, not withdrawn rows that have no confirmation row and whose detector is of a vendor other than the second model's, newest published first, at most 10 a tick and while the second model's vendor's cap for today allows.

#### Scenario: Rows from the switched-off days
- **WHEN** rows published by terra on 2026-11-08 have no confirmation row and Anthropic's cap allows
- **THEN** the tick confirms up to 10 of them, the newest first

#### Scenario: Same-vendor detector
- **WHEN** a row was published by a Sonnet run with no confirmation row and the second model is Haiku
- **THEN** it is not in the backlog

#### Scenario: Cap spent
- **WHEN** Anthropic's spend today reaches its cap
- **THEN** the tick confirms no backlog row and the backlog waits for the next UTC day

#### Scenario: Withdrawn row
- **WHEN** a row without a confirmation is withdrawn
- **THEN** it is not confirmed while withdrawn, and joins the backlog again if it is restored

#### Scenario: Switched off
- **WHEN** `AI_SECOND_ENABLED` or `AI_BUDGET_ENABLED` is unset or `off`
- **THEN** no backlog row is confirmed

### Requirement: A later confirmation gates only the model's own served entries
A later second call SHALL be made on the stored run's transcript and the current prompt, and SHALL move to `hidden` as `unconfirmed` each served entry that came from a first-model segment the second model did not find (same category, IoU ≥ 0.3), with a `D` item under the day's cap. An entry whose bounds an assessor set, or whose latest ai-item verdict is a keep, SHALL stay served.

#### Scenario: Entry not found
- **WHEN** the later call does not find the first model's sponsor 300–360 and the entry is served with no verdict
- **THEN** the entry moves to `hidden` as `unconfirmed`, its rating leaves the JSON, a `D` item is created if the day's sheet has room, and the confirmation row is written

#### Scenario: Entry kept by an assessor
- **WHEN** the later call does not find an entry whose latest ai-item verdict is a keep
- **THEN** the entry stays served, and the confirmation row counts it as unconfirmed

#### Scenario: Entry moved by the chapter check
- **WHEN** a served entry's bounds were moved to a chapter's and the second model found its first-model segment
- **THEN** the entry stays served at the chapter's bounds

#### Scenario: Row left empty
- **WHEN** every served entry of a row is unconfirmed
- **THEN** the row serves nothing and is not withdrawn

#### Scenario: Hidden entries
- **WHEN** a row has entries hidden as `confidence`, `short` or `review`
- **THEN** a later confirmation leaves them where they are

### Requirement: A failed later confirmation changes no entry
When a later second call fails, the system SHALL leave the row's entries as they are and SHALL log it without counting a failed video of the tick. A call that got no answer (transport or API error) SHALL write nothing, so the row is tried again on a later tick; an answer that came back but does not parse or validate SHALL write the confirmation row with the error, as at publish, so it is not paid for again.

#### Scenario: API error
- **WHEN** a backlog call returns a 529 with no answer
- **THEN** the row keeps serving what it served, the log says `confirm backlog failed`, no confirmation row is written and the row stays in the backlog

#### Scenario: Invalid answer
- **WHEN** a backlog call's answer has a cue index outside the transcript
- **THEN** the row keeps serving what it served, a confirmation row with the validation error is written and the row leaves the backlog
