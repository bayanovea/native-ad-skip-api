# Spec Delta

## Purpose
Defines the second-model confirmation of AI-detected segments: a segment reaches viewers only when a second, independent model found it too; the rest goes to an assessor, and the second model's answers are recorded for measurement.

## ADDED Requirements

### Requirement: The second opinion is off unless switched on
The system SHALL make no second-model call and SHALL publish exactly as before this change unless the second-opinion switch is set to a client. Turning it on is an environment change; no code default or migration turns it on.

#### Scenario: Default environment
- **WHEN** the switch is unset or `off` and a video's detection answer arrives
- **THEN** the video is published from that answer alone, no confirmation row is written and no entry has the reason `unconfirmed`

#### Scenario: Switched on without a key
- **WHEN** the switch names the real client and its API key is unset
- **THEN** a detect tick that would call the model exits with an error naming the key before any fetch, as the Claude client does without its key

### Requirement: Every answered video gets one second-model call
With the switch on, after the first model's answer validates, the system SHALL make one synchronous call to the second model with the same prompt text, the same transcript rendering and the same output schema, on the cron tick and in the manual run alike, and SHALL validate the answer against the transcript as the first one is.

#### Scenario: Batch answer resolved on a tick
- **WHEN** a batch ends with answers for three videos
- **THEN** each video gets its own second call before it is published, and the tick's own duration grows by those calls

#### Scenario: Manual run
- **WHEN** `ai detect <native_id>` gets the first answer
- **THEN** the second call is made in the same run and the video's outcome reflects it

#### Scenario: Nothing to confirm
- **WHEN** the first model returned no segments
- **THEN** the second call is still made and recorded (its segments are the measurement), and the row is published with empty `data` as today

### Requirement: A segment is served only when both models found it
A first-model segment that passes the confidence and length rules SHALL be served only when a second-model segment of the same category overlaps it with an intersection over union of at least 0.3; otherwise it SHALL be hidden with the reason `unconfirmed`. The served bounds are the first model's.

#### Scenario: Agreement
- **WHEN** the first model found sponsor 120–180 (high) and the second model found sponsor 125–185
- **THEN** sponsor 120–180 is served

#### Scenario: Same ad, different edges
- **WHEN** the first model found sponsor 1000–1040 and the second model found sponsor 1015–1055 (IoU 25/55)
- **THEN** sponsor 1000–1040 is served

#### Scenario: Different category
- **WHEN** the first model found sponsor 120–180 and the second model found self_promotion 120–180
- **THEN** sponsor 120–180 is hidden with the reason `unconfirmed`

#### Scenario: Too little overlap
- **WHEN** the first model found sponsor 120–180 and the second model's nearest sponsor segment is 170–240
- **THEN** sponsor 120–180 is hidden with the reason `unconfirmed`

#### Scenario: Hidden entries keep their reason
- **WHEN** a first-model segment is below the confidence threshold or shorter than the minimum, whatever the second model says
- **THEN** it is hidden with the reason `confidence` or `short` as today, never `unconfirmed`

#### Scenario: Only the second model found a segment
- **WHEN** the second model found a segment that overlaps no first-model segment of its category
- **THEN** no entry is created for it; it is counted on the confirmation row

### Requirement: An unconfirmed entry gets a review item
For every entry hidden as `unconfirmed`, the system SHALL create one ai review item on it in the day's second-opinion sheet, placed like the judge's items (newest part nobody holds or has started, within the part size), with priority `important`, codes `D<n>`, the entry's category as proposed, its transcript as cues and the player link at start − 2 s. The item's `flagged_by` names the second model and that it did not find the segment, blind until decided.

#### Scenario: Two unconfirmed entries
- **WHEN** a video is published with two `unconfirmed` entries
- **THEN** two open ai items exist on that row, in a batch of the sheet `ai-second-<today>` that nobody holds

#### Scenario: Verdicts act as on any ai item
- **WHEN** an assessor keeps an `unconfirmed` entry
- **THEN** it is served (with bounds when given, unless shorter than the minimum); a `not_ad` or `unclear` verdict hides it with the reason `review`

### Requirement: A second-model failure degrades to the first model alone
When the second call fails (transport or API error, an answer that does not parse or fails validation against the transcript), the system SHALL publish the video from the first model's answer exactly as without the switch, SHALL record the failure on the confirmation row and in the log, and SHALL NOT count the video as a failed video of the tick.

#### Scenario: API error
- **WHEN** the second call returns an error for one video of a tick
- **THEN** that video is published with its first-model segments served as today, the confirmation row carries the error text, the log says `second opinion failed`, and the tick's heartbeat counts no failed video for it

#### Scenario: Invalid answer
- **WHEN** the second model's answer has a cue index outside the transcript
- **THEN** the video is published as without the switch and the confirmation row records the validation error

### Requirement: Every second call is recorded with its cost
The system SHALL write one confirmation row per second call: the run it confirms, the model, the raw output, token usage, cost, the error when any, how many first-model segments were confirmed and unconfirmed and how many second-model segments matched nothing. The cost SHALL appear on `/metrics` as the kind `confirm` next to `detect` and `judge`, in the total and in the 24 h sum the daily cost alert reads.

#### Scenario: Metrics
- **WHEN** two second calls were made in the last 24 h
- **THEN** `ai_cost_usd{kind="confirm"}` and `ai_cost_usd_24h{kind="confirm"}` carry their summed cost and the detect budget count is unchanged by them

### Requirement: A rule change never serves an unconfirmed entry
`ai regate` SHALL leave an `unconfirmed` entry hidden whatever the confidence and length rules say, unless its latest ai-item verdict is a keep, in which case it is placed by the length rule as any pinned entry.

#### Scenario: Threshold lowered
- **WHEN** `AI_MIN_SEGMENT_SECONDS` is lowered and `ai regate` runs over a row with an `unconfirmed` entry and no verdict
- **THEN** the entry stays hidden with the reason `unconfirmed`

#### Scenario: Kept on review
- **WHEN** the entry's latest ai-item verdict is a keep
- **THEN** `ai regate` serves it, or hides it as `short` when under the minimum

### Requirement: The dashboard shows the second opinion
The AI dashboard SHALL count `unconfirmed` entries in the hidden-by-reason panel and SHALL show, from the confirmation rows, the calls per day, the share of first-model segments confirmed, the failures with their reasons, the second-model-only segments and the cost.

#### Scenario: Panels read the rows
- **WHEN** confirmation rows exist
- **THEN** the second-opinion row of the dashboard shows their counts, and the hidden-by-reason panel has an `unconfirmed` column
