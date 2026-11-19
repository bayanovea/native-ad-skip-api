# Spec Delta

## Purpose

Paces the AI pipeline's model spend against each vendor's monthly allowance, so that both allowances are used up to
their reserve by their reset days and never overrun, and shows where the money went and what is left.

## ADDED Requirements

### Requirement: The budget is off unless switched on
The system SHALL pace nothing and SHALL claim and confirm exactly as before this change unless `AI_BUDGET_ENABLED` is
`on`. Turning it on is an environment change; no code default or migration turns it on.

#### Scenario: Default environment
- **WHEN** `AI_BUDGET_ENABLED` is unset or `off`
- **THEN** the detect tick claims up to `AI_BATCH_MAX` videos under `AI_DAILY_BUDGET_VIDEOS`, every answered video gets its second call when `AI_SECOND_ENABLED` is `on`, no confirmation backlog is worked and no budget state is written

#### Scenario: Switched on without an allowance
- **WHEN** `AI_BUDGET_ENABLED` is `on` and any of `AI_BUDGET_OPENAI_USD`, `AI_BUDGET_OPENAI_RESET_DAY`, `AI_BUDGET_ANTHROPIC_USD`, `AI_BUDGET_ANTHROPIC_RESET_DAY` is unset or invalid
- **THEN** the detect tick exits 1 at startup with an error naming the variable, before any claim

### Requirement: Each vendor has an allowance cycle
Each vendor (OpenAI, Anthropic) SHALL have a cycle that starts at 00:00 UTC on its reset day (`AI_BUDGET_<VENDOR>_RESET_DAY`, 1–28) and ends at the next one. The usable amount SHALL be `AI_BUDGET_<VENDOR>_USD × (1 − AI_BUDGET_RESERVE)`, the reserve defaulting to 0.1.

#### Scenario: Cycle boundaries
- **WHEN** the reset day is 10 and today is 2026-11-19
- **THEN** the cycle runs from 2026-11-10 00:00 UTC to 2026-12-10 00:00 UTC

#### Scenario: Before this month's reset day
- **WHEN** the reset day is 19 and today is 2026-12-05
- **THEN** the cycle runs from 2026-11-19 to 2026-12-19

#### Scenario: Reserve
- **WHEN** `AI_BUDGET_OPENAI_USD` is 200 and `AI_BUDGET_RESERVE` is unset
- **THEN** OpenAI's usable amount is 180

### Requirement: Spend is the product's recorded cost
A vendor's spend SHALL be the sum of the recorded cost of every model call whose model belongs to that vendor, from detector runs, second-opinion calls, judgements and batch audits, created within the cycle. A detector run whose answer has not come back SHALL count at the vendor's recent average cost per run.

#### Scenario: Calls of both vendors
- **WHEN** this cycle holds terra runs for $16 and Haiku confirmations for $3, Sonnet judgements for $0.2 and audits for $0.1
- **THEN** OpenAI's spend is $16 and Anthropic's $3.3

#### Scenario: A batch in flight
- **WHEN** 40 terra runs wait in a batch and the last 200 priced terra runs averaged $0.012
- **THEN** OpenAI's spend includes $0.48 for them until their answers are priced

### Requirement: Today's cap spreads what is left over the days to the reset
A vendor's cap for today SHALL be its usable amount minus its spend before today (UTC), divided by the days from today to the cycle's end, today included; never below 0.

#### Scenario: Even pace
- **WHEN** OpenAI's usable amount is $180, $16 were spent before today, and today is 2026-11-19 with the reset on 2026-12-10
- **THEN** today's cap is (180 − 16) / 21 ≈ $7.81

#### Scenario: Overspent
- **WHEN** the spend before today already exceeds the usable amount
- **THEN** today's cap is 0

### Requirement: The detector claims only what OpenAI's cap pays for
With the budget on, the detect tick SHALL claim at most as many videos as the detector vendor's cap for today, minus today's spend, pays for at that vendor's recent average cost per run; the `AI_BATCH_MAX` and `AI_DAILY_BUDGET_VIDEOS` limits SHALL still apply.

#### Scenario: Room for two
- **WHEN** OpenAI's cap is $7.81, $7.78 is spent today and a run averages $0.012
- **THEN** the tick claims at most two videos

#### Scenario: Cap spent
- **WHEN** today's spend reaches the cap
- **THEN** the tick claims nothing and the queue waits for the next UTC day

#### Scenario: Hard ceiling still holds
- **WHEN** the cap would pay for 50 videos and `AI_BATCH_MAX` is 5
- **THEN** the tick claims at most five

#### Scenario: Manual run
- **WHEN** the operator runs `ai detect <native_id>` with the cap spent
- **THEN** the video is detected as before, and its cost counts in the spend

### Requirement: The budget state is stored on every tick
With the budget on, every detect tick SHALL upsert one row per vendor with its allowance, reserve, cycle start and end, spend this cycle, spend today, today's cap, the forecast left unspent at the reset at the last seven days' pace and the confirmation backlog size.

#### Scenario: A tick
- **WHEN** a detect tick runs with the budget on
- **THEN** the OpenAI and Anthropic rows carry this tick's numbers and its time

#### Scenario: Switched off
- **WHEN** a detect tick runs with `AI_BUDGET_ENABLED` off
- **THEN** the rows are left as they are and the dashboard shows them as stale by their time

### Requirement: The dashboard shows the budgets
The AI dashboard SHALL show, per vendor, from the stored state: allowance, spend this cycle, what is left, days to the reset, today's cap and spend, the forecast left unspent at the reset, and the spend of this cycle by kind (detect, confirm, judge, audit).

#### Scenario: Opened mid-cycle
- **WHEN** the dashboard is opened
- **THEN** a budget row shows both vendors' numbers and the time of the state they come from

#### Scenario: Money left on the table
- **WHEN** the forecast left unspent at OpenAI's reset exceeds 20 % of its usable amount
- **THEN** the forecast panel shows it in the warning colour, the signal for lowering `AI_MIN_VIEWS`

### Requirement: A day's spend far past its cap alerts
An alert SHALL fire when a vendor's spend today exceeds 1.5 × its cap for today plus $1, or its spend this cycle exceeds its full allowance.

#### Scenario: Runaway spend
- **WHEN** Anthropic's cap today is $2.9 and $6 is spent today
- **THEN** the alert fires naming the vendor

#### Scenario: Budget off
- **WHEN** `AI_BUDGET_ENABLED` is off and no state row is fresher than a day
- **THEN** the alert does not fire (no data is OK)
