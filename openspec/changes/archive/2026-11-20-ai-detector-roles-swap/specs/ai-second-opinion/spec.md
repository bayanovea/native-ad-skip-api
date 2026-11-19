# Spec Delta

## MODIFIED Requirements

### Requirement: The second opinion is off unless switched on
The system SHALL make no second-model call and SHALL publish exactly as before this change unless `AI_SECOND_ENABLED` is `on`; which client makes the call (`AI_SECOND_CLIENT`: `openai`, `anthropic` or `fixture`) is a separate setting. Turning it on is an environment change; no code default or migration turns it on.

#### Scenario: Default environment
- **WHEN** `AI_SECOND_ENABLED` is unset or `off` and a video's detection answer arrives
- **THEN** the video is published from that answer alone, no confirmation row is written and no entry has the reason `unconfirmed`

#### Scenario: A client set while the switch is off
- **WHEN** `AI_SECOND_CLIENT` is set and `AI_SECOND_ENABLED` is unset or `off`
- **THEN** nothing changes and no key is needed

#### Scenario: Switched on without a key
- **WHEN** `AI_SECOND_ENABLED` is `on`, `AI_SECOND_CLIENT` is `openai` and `OPENAI_API_KEY` is unset
- **THEN** a detect tick that would call the model exits with an error naming the key before any fetch, as the Claude client does without its key

#### Scenario: Claude as the second model
- **WHEN** `AI_SECOND_ENABLED` is `on`, `AI_SECOND_CLIENT` is `anthropic` and `AI_SECOND_MODEL` is a Claude model
- **THEN** each second call is one synchronous Messages API call to that model, and the confirmation row and the `D` items name it

#### Scenario: Claude as the second model without a key
- **WHEN** `AI_SECOND_ENABLED` is `on`, `AI_SECOND_CLIENT` is `anthropic` and `ANTHROPIC_API_KEY` is unset
- **THEN** a detect tick that would call the model exits with an error naming `ANTHROPIC_API_KEY` before any fetch

#### Scenario: Unknown client
- **WHEN** `AI_SECOND_CLIENT` is a value other than `openai`, `anthropic` or `fixture`
- **THEN** `ai detect` and `ai regate` exit 1 at startup with an error naming `AI_SECOND_CLIENT` and its allowed values, as they do today for a bad value

### Requirement: The dashboard shows the second opinion
The AI dashboard SHALL count `unconfirmed` entries in the hidden-by-reason panel and SHALL show, from the confirmation rows, the calls per day, the share of first-model segments confirmed, the failures with their reasons, the second-model-only segments and the cost. The failure reasons SHALL read the same for either vendor's error texts.

#### Scenario: Panels read the rows
- **WHEN** confirmation rows exist
- **THEN** the second-opinion row of the dashboard shows their counts, and the hidden-by-reason panel has an `unconfirmed` column

#### Scenario: An exhausted account of either vendor
- **WHEN** one confirmation row carries OpenAI's `insufficient_quota` and another Anthropic's `credit balance is too low`
- **THEN** the failure reasons panel counts both as the account's budget running out

#### Scenario: Anthropic overloaded
- **WHEN** a confirmation row carries Anthropic's `529` `overloaded_error`
- **THEN** the failure reasons panel counts it as an API failure or timeout

### Requirement: An unconfirmed entry gets a review item
For every entry hidden as `unconfirmed`, the system SHALL create one ai review item on it in the day's second-opinion sheet, placed like the judge's items (newest part nobody holds or has started, within the part size), with priority `important`, codes `D<n>`, the entry's category as proposed, its transcript as cues and the player link at start − 2 s, until the day's sheet holds 30 items; past that, the entry SHALL stay hidden as `unconfirmed` with no item. The day is the UTC date in the sheet's name. The item's `flagged_by` names the second model and that it did not find the segment, blind until decided.

#### Scenario: Switched off
- **WHEN** `AI_SECOND_ENABLED` is unset or `off`
- **THEN** publish creates no review item, as today

#### Scenario: Two unconfirmed entries
- **WHEN** a video is published with two `unconfirmed` entries and the sheet `ai-second-<today>` holds fewer than 29 items
- **THEN** two open ai items exist on that row, in a batch of that sheet that nobody holds

#### Scenario: The day's cap reached mid-video
- **WHEN** the sheet `ai-second-<today>` holds 28 items and a video is published with three `unconfirmed` entries
- **THEN** two items are created, all three entries are hidden as `unconfirmed`, and the confirmation row counts three unconfirmed

#### Scenario: The day's cap reached
- **WHEN** the sheet `ai-second-<today>` holds 30 items and a video is published with `unconfirmed` entries
- **THEN** no review item is created, the entries are hidden as `unconfirmed` and nothing more is served

#### Scenario: Verdicts act as on any ai item
- **WHEN** an assessor keeps an `unconfirmed` entry
- **THEN** it is served (with bounds when given, unless shorter than `AI_MIN_SEGMENT_SECONDS`); a `not_ad` or `unclear` verdict hides it with the reason `review`
