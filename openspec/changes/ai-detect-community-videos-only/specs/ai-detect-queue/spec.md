# Spec Delta

## ADDED Requirements

### Requirement: Only community videos are taken automatically
The scheduled detect tick SHALL take a video only when its `native_id` starts with `-` (a prv community video). A video whose `native_id` has no leading `-` (a user upload) SHALL never be claimed by the tick, in any queue state; the manual run for one video SHALL still take it.

#### Scenario: Community video past a threshold
- **WHEN** a seen video `-111_222` has `requests ≥ AI_MIN_REQUESTS`
- **THEN** the next detect tick claims it

#### Scenario: User upload past both thresholds
- **WHEN** a seen video `111_222` has `views_max ≥ AI_MIN_VIEWS` and `requests ≥ AI_MIN_REQUESTS`
- **THEN** the detect tick leaves it `seen`

#### Scenario: User upload waiting for a retry
- **WHEN** a video `111_222` is `queued` with `next_attempt_at` in the past
- **THEN** the detect tick does not claim it

#### Scenario: Manual run on a user upload
- **WHEN** the operator runs `ai detect 111_222`
- **THEN** the video is claimed and detected as before

#### Scenario: Read path
- **WHEN** a client requests `111_222` with `v`
- **THEN** its `prv_ai_videos` row is created or updated as for any prv id

### Requirement: The dashboard counts user uploads apart
The AI pipeline funnel SHALL count user uploads that the tick will not take (`seen`, `queued`, `fetching`) in their own stage, and the panels of the waiting stages SHALL exclude them.

#### Scenario: User upload in the funnel
- **WHEN** `111_222` is `seen` with 1000000 views
- **THEN** the funnel counts it in stage 0, not in stage 1 or 2
