# Spec Delta

## Purpose

Defines which vendor and transport make the detector's model call in `ai detect`: how the switch picks it, how the cron tick and the manual run differ, how a misconfiguration fails, and how batches in flight survive a change of transport.

## ADDED Requirements

### Requirement: The detector's transport comes from its own switch
The system SHALL pick the detector's transport from `AI_DETECT_CLIENT`: `anthropic`, `messages`, `openai-batch`, `openai` or `fixture`. When it is empty, `AI_CLIENT`'s value SHALL be used, and when both are empty, `anthropic`. Any other value SHALL be a startup error of a tick that would call the model. The judge and the audit SHALL keep reading `AI_CLIENT` only.

#### Scenario: Default environment
- **WHEN** `AI_DETECT_CLIENT` and `AI_CLIENT` are unset and a detect tick runs
- **THEN** the detector calls Claude through the Batches API on the cron tick and through the Messages API in the manual run, as before this change

#### Scenario: Fallback to the shared client
- **WHEN** `AI_DETECT_CLIENT` is unset and `AI_CLIENT` is `fixture`
- **THEN** the detector answers from the fixture files, as before this change

#### Scenario: Unknown value
- **WHEN** `AI_DETECT_ENABLED` is `on` and `AI_DETECT_CLIENT` is `gemini`
- **THEN** the tick exits 1 with an error naming `AI_DETECT_CLIENT` and its allowed values, before any fetch

#### Scenario: Switched-off tick
- **WHEN** `AI_DETECT_ENABLED` is unset or `off` and `AI_DETECT_CLIENT` holds any value
- **THEN** the tick only expires stale runs and clears its heartbeat, as before this change

#### Scenario: The judge and the audit are not affected
- **WHEN** `AI_DETECT_CLIENT` is `openai-batch` and `AI_CLIENT` is unset
- **THEN** `ai judge` and `ai audit` call Claude through the Messages API as before

### Requirement: The cron tick uses the batch transport, the manual run calls synchronously
With `openai-batch`, the cron tick SHALL submit the claimed videos as one OpenAI Batch API batch and resolve it on a later tick, and the manual run `ai detect <native_id>` SHALL call the same model synchronously through the Chat Completions API. `openai` SHALL call synchronously on both. `anthropic` and `messages` SHALL behave as before this change.

#### Scenario: Default environment
- **WHEN** `AI_DETECT_CLIENT` is unset
- **THEN** a cron tick submits a Claude batch and the manual run makes one Messages call, as before this change

#### Scenario: OpenAI batch on the cron tick
- **WHEN** `AI_DETECT_CLIENT` is `openai-batch` and a tick claims three videos that pass the gate
- **THEN** one OpenAI batch carries the three requests, each video is `detecting` with that batch's id, and a later tick that finds the batch ended publishes the three videos

#### Scenario: Manual run on openai-batch
- **WHEN** `AI_DETECT_CLIENT` is `openai-batch` and the owner runs `ai detect <native_id>`
- **THEN** the run makes one synchronous OpenAI call and exits 0 only if the video ends published, as the manual run does today

### Requirement: The detector and the second model must match their transports
A tick that would call a model SHALL exit 1 before any fetch, with an error naming the variables, when a `claude-*` model is set for an OpenAI transport or a model that is not `claude-*` for an Anthropic one: `AI_MODEL` against the detector's transport, and, with `AI_SECOND_ENABLED` on, `AI_SECOND_MODEL` against `AI_SECOND_CLIENT`. `fixture` SHALL accept any model.

#### Scenario: Default environment
- **WHEN** `AI_MODEL`, `AI_DETECT_CLIENT`, `AI_SECOND_CLIENT` and `AI_SECOND_MODEL` are unset
- **THEN** the defaults match (Claude on Anthropic, `gpt-6-luna` on OpenAI) and the tick runs as before

#### Scenario: Half-applied variables for the detector
- **WHEN** `AI_DETECT_CLIENT` is `openai-batch` and `AI_MODEL` is unset (its default is a Claude model)
- **THEN** the tick exits 1 naming `AI_MODEL` and `AI_DETECT_CLIENT`, and no video is claimed

#### Scenario: Half-applied variables for the second model
- **WHEN** `AI_SECOND_ENABLED` is `on`, `AI_SECOND_CLIENT` is `anthropic` and `AI_SECOND_MODEL` is unset (its default is an OpenAI model)
- **THEN** the tick exits 1 naming `AI_SECOND_MODEL` and `AI_SECOND_CLIENT`

#### Scenario: Second model switched off
- **WHEN** `AI_SECOND_ENABLED` is unset or `off`, whatever `AI_SECOND_CLIENT` and `AI_SECOND_MODEL` say
- **THEN** they are not checked

### Requirement: An OpenAI transport without its key is a startup error
With `AI_DETECT_CLIENT` `openai-batch` or `openai`, a tick that would call the model SHALL exit 1 before any fetch with an error naming `OPENAI_API_KEY` when it is unset, as the Anthropic transports do without `ANTHROPIC_API_KEY`.

#### Scenario: Default environment
- **WHEN** `AI_DETECT_CLIENT` is unset and `OPENAI_API_KEY` is unset
- **THEN** the detector needs no OpenAI key (the second opinion's own check is unchanged)

#### Scenario: Key missing
- **WHEN** `AI_DETECT_ENABLED` is `on`, `AI_DETECT_CLIENT` is `openai-batch` and `OPENAI_API_KEY` is unset
- **THEN** the tick exits 1 naming `OPENAI_API_KEY`, and no video is claimed

### Requirement: A batch is resolved by the transport that submitted it
A tick SHALL poll and read every waiting batch through the vendor of the model recorded on its videos' latest run, whatever the detector's transport is now, and SHALL price its answers with that model's price. A batch in flight when the transport changes SHALL be published as if nothing had changed.

#### Scenario: Default environment
- **WHEN** the transport never changes
- **THEN** every batch is polled through the current transport, as before this change

#### Scenario: Swap with a Claude batch in flight
- **WHEN** a Claude batch is waiting and the next deploy sets `AI_DETECT_CLIENT` to `openai-batch` and `AI_MODEL` to an OpenAI model
- **THEN** the next ticks poll that batch through the Anthropic API, publish its videos with the Claude model's cost, submit new videos to OpenAI, and the heartbeat counts no failed video for the old batch

#### Scenario: Rollback with an OpenAI batch in flight
- **WHEN** an OpenAI batch is waiting and the variables are cleared back to the defaults
- **THEN** the batch is still polled through the OpenAI API until it ends or expires after 24 h

### Requirement: Batch answers are priced at the batch discount
The cost recorded on a run SHALL be the model's price times one half when the answer came from either vendor's batch transport, and the full price when it came from a synchronous call.

#### Scenario: Default environment
- **WHEN** a Claude batch answer is recorded
- **THEN** its cost is half of the Claude model's price for its usage, as before this change

#### Scenario: OpenAI batch
- **WHEN** an OpenAI batch answer with 24 000 input and 1 500 output tokens is recorded for a model priced $1 / $5 per million
- **THEN** the run's cost is $0.01575

#### Scenario: Manual run
- **WHEN** the manual run on `openai-batch` gets the same answer synchronously
- **THEN** the run's cost is $0.0315

### Requirement: A rejected batch submit spends no attempt
When the vendor rejects a batch submit (a spend limit, a rate limit, an outage), the system SHALL drop the submit's run rows, SHALL queue the videos again in an hour with the error on the queue row, SHALL NOT count them against the daily budget or their attempts, and SHALL count them as failed videos of the tick.

#### Scenario: Default environment
- **WHEN** a Claude batch submit is rejected
- **THEN** the videos are queued again in an hour with no attempt spent, as before this change

#### Scenario: OpenAI batch failed as a whole
- **WHEN** an OpenAI batch ends with status `failed` (the organization's enqueued-token limit, a validation error) and no output or error file
- **THEN** each of its videos is handled as a rejected submit: no run row remains, it is `queued` with `next_attempt_at` an hour later, no attempt is spent, and it counts as a failed video of the tick

#### Scenario: OpenAI project spend limit reached
- **WHEN** an OpenAI batch submit returns 429 `project_spend_limit_exceeded`
- **THEN** no run row remains for the videos, each is `queued` with `next_attempt_at` an hour later and `last_error` starting `batch submit:`, and the daily budget count is unchanged

### Requirement: A batch request without an answer fails only its video
When a batch ends but one of its requests has no successful answer (the vendor marked it failed or expired), the system SHALL record that video's run as failed with the vendor's error and SHALL publish the batch's other videos.

#### Scenario: Default environment
- **WHEN** a Claude batch ends with one errored request
- **THEN** that video fails and the others are published, as before this change

#### Scenario: One OpenAI request expired
- **WHEN** an OpenAI batch of three ends with one request in its error file
- **THEN** that video is `failed` with the error text on its run and the other two are published
