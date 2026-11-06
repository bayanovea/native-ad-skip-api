# Spec Delta

## ADDED Requirements

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
