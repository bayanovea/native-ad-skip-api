# Spec Delta

## MODIFIED Requirements

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
- **THEN** the tick claims nothing, as before, whatever `AI_BUDGET_ENABLED` says

#### Scenario: Spend cap
- **WHEN** `AI_BUDGET_ENABLED` is `on` and the detector vendor's cap for today pays for two more runs
- **THEN** the tick claims the two highest-scored eligible videos
