# Spec Delta

## Purpose

Defines which seen videos the AI detector takes from its queue, by which of two independent popularity criteria, and how that trigger is recorded for the dashboard.

## ADDED Requirements

### Requirement: A video qualifies by views or by requests
A `seen` video SHALL qualify for detection when its known view count is at least `AI_MIN_VIEWS` or its request count is at least `AI_MIN_REQUESTS`; the two criteria are independent, and an unknown view count never disqualifies a video.

#### Scenario: Views reach the threshold
- **WHEN** a seen video has `views_max ≥ AI_MIN_VIEWS` and fewer than `AI_MIN_REQUESTS` requests
- **THEN** the next detect tick claims it

#### Scenario: Requests reach the threshold with a known low view count
- **WHEN** a seen video has `views_max < AI_MIN_VIEWS` and `requests ≥ AI_MIN_REQUESTS`
- **THEN** the next detect tick claims it

#### Scenario: Requests reach the threshold with no view count
- **WHEN** a seen video has `views_max` NULL and `requests ≥ AI_MIN_REQUESTS`
- **THEN** the next detect tick claims it, and no view count is read from yt-dlp to re-check it

#### Scenario: Neither threshold reached
- **WHEN** a seen video has `views_max < AI_MIN_VIEWS` (or NULL) and `requests < AI_MIN_REQUESTS`
- **THEN** it stays `seen`

### Requirement: Thresholds come from the environment with the new defaults
`AI_MIN_VIEWS` SHALL default to 500000 and `AI_MIN_REQUESTS` to 20; `AI_FALLBACK_REQUESTS` SHALL no longer be read.

#### Scenario: Unset variables
- **WHEN** neither variable is set
- **THEN** the detector uses 500000 views and 20 requests

#### Scenario: Only the old name is set
- **WHEN** `AI_FALLBACK_REQUESTS=5` is set and `AI_MIN_REQUESTS` is not
- **THEN** the detector uses 20 requests

### Requirement: The trigger is recorded on the first claim
On the first claim of a video the detector SHALL store on its `prv_ai_videos` row which criterion let it in: `views`, `requests` or `both`, evaluated against that tick's thresholds; a manual run stores `manual`. Later claims of the same video (retries, a stale fetch) SHALL keep the stored value.

#### Scenario: Both thresholds met
- **WHEN** a video is claimed with `views_max ≥ AI_MIN_VIEWS` and `requests ≥ AI_MIN_REQUESTS`
- **THEN** `queued_by = 'both'`

#### Scenario: Retry after a missing track
- **WHEN** a video claimed as `requests` goes `queued` for a missing subtitle track and is claimed again
- **THEN** `queued_by` stays `requests`

#### Scenario: Manual run
- **WHEN** `ai detect <native_id>` claims a video that was never claimed before
- **THEN** `queued_by = 'manual'`

#### Scenario: Rows claimed before this change
- **WHEN** a video was claimed before the column existed
- **THEN** `queued_by` is NULL and the dashboard counts it as "unknown"

### Requirement: The dashboard shows why videos were taken
The AI pipeline dashboard SHALL show the current count of videos per trigger and the model runs per day per trigger, and its stage-1 "below the threshold" panels SHALL apply the same rule as the detector with its current defaults.

#### Scenario: Trigger split
- **WHEN** the dashboard is opened
- **THEN** a panel lists `views`, `requests`, `both`, `manual` and `unknown` with the number of videos each

#### Scenario: A video below both thresholds
- **WHEN** a seen video has 400000 views and 19 requests at the default thresholds
- **THEN** the funnel counts it in stage 1
