# ai-detect-queue Specification

## Purpose
Defines which seen videos the AI detector takes from its queue, by which of two independent popularity criteria, and how that trigger is recorded for the dashboard.

## Requirements

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

### Requirement: Eligible videos are claimed by priority score
The detect tick SHALL claim eligible videos in descending order of a priority score, ties broken by `first_seen_at` then `native_id`, instead of oldest first. The score is `ln(views_max / AI_MIN_VIEWS + requests / AI_MIN_REQUESTS + 1)` (an unknown `views_max` counts as 0) divided by `1 + days since first_seen_at`, multiplied by the channel factor and the human-markup factor defined below. Due retries and stale `fetching` rows sort by the same score.

#### Scenario: More viewers first
- **WHEN** two `seen` community videos first requested at the same time are eligible, one with 5000000 views and one with 600000, and the tick may claim one
- **THEN** the video with 5000000 views is claimed

#### Scenario: Requests weigh as views
- **WHEN** a video with `views_max` NULL and 20 requests and a video with 500000 views and 1 request are eligible, equally old, same channel history, no human markup
- **THEN** the one with 20 requests is claimed first (its score is the higher by the requests term)

#### Scenario: Freshness
- **WHEN** a video with 2000000 views first requested 3 days ago and a video with 1000000 views first requested today are eligible, same factors
- **THEN** the newer one is claimed first

#### Scenario: Admission unchanged
- **WHEN** a `seen` community video has `views_max < AI_MIN_VIEWS` and `requests < AI_MIN_REQUESTS`
- **THEN** it is not claimed whatever its score would be

#### Scenario: Budget unchanged
- **WHEN** the last 24 hours hold `AI_DAILY_BUDGET_VIDEOS` runs
- **THEN** the tick claims nothing, as before

### Requirement: Channel history scales the score
The score SHALL be multiplied by 1.5 when the latest AI row of the video's channel (the part of `native_id` before `_`, any row state) has at least one served entry, by 0.5 when the channel has at least two AI rows and none of them has a served entry, and by 1 otherwise.

#### Scenario: Channel with an ad in its latest row
- **WHEN** the channel's most recently published AI row has a non-empty served list
- **THEN** the video's score is × 1.5

#### Scenario: Channel with two empty rows
- **WHEN** the channel has two AI rows, both with an empty served list
- **THEN** the video's score is × 0.5

#### Scenario: Channel with one empty row
- **WHEN** the channel has exactly one AI row and it has an empty served list
- **THEN** the video's score is × 1

#### Scenario: Unknown channel
- **WHEN** the channel has no AI row
- **THEN** the video's score is × 1

#### Scenario: Latest row empty after earlier rows with ads
- **WHEN** the channel's latest AI row has an empty served list and an earlier one has entries
- **THEN** the video's score is × 1

### Requirement: An existing human ad markup scales the score down
The score SHALL be multiplied by 0.3 when any `videos` row of the video's `native_id` has a live (not deleted) markup of category `sponsor` or `self_promotion`.

#### Scenario: Live sponsor markup
- **WHEN** a user's sponsor markup on the video is live
- **THEN** the video's score is × 0.3

#### Scenario: Deleted markup
- **WHEN** the only sponsor markup on the video is soft-deleted
- **THEN** the video's score is unchanged

#### Scenario: Markup of another category
- **WHEN** the video has only live `intro` or `credits` markups
- **THEN** the video's score is unchanged

### Requirement: A waiting video expires after 14 days
A `seen` video whose `first_seen_at` is more than 14 days in the past SHALL not be eligible for the scheduled tick, whatever its views and requests; a later request SHALL not make it eligible again. The manual run SHALL still take it.

#### Scenario: Old eligible video
- **WHEN** a `seen` community video has `views_max ≥ AI_MIN_VIEWS` and was first requested 15 days ago
- **THEN** the tick leaves it `seen`

#### Scenario: Request after the cut
- **WHEN** such a video is requested again today
- **THEN** it stays `seen` and is not claimed

#### Scenario: Within the window
- **WHEN** a `seen` community video past a threshold was first requested 13 days ago
- **THEN** it is eligible, with the score of its age

#### Scenario: Manual run
- **WHEN** the operator runs `ai detect <native_id>` on a video first requested 15 days ago
- **THEN** it is claimed and detected as before

### Requirement: The dashboard shows the queue by value and what the order gave up
The AI pipeline dashboard's queue count and funnel stage 2 SHALL apply the 14-day cut, and the queue row SHALL show the eligible videos by views band and the number of videos that expired unprocessed.

#### Scenario: Expired video on the dashboard
- **WHEN** a `seen` community video past a threshold was first requested 15 days ago
- **THEN** it is counted as expired and not in the queue count or stage 2

#### Scenario: Queue by band
- **WHEN** the dashboard is opened
- **THEN** a panel lists the eligible videos per views band with the number of videos in each
