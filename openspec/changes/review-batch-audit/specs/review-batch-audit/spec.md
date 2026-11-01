# Spec Delta

## Purpose
Defines the automatic audit of finished assessor review batches: which batches are audited and when, what an audit computes and records, and how its findings reach the owner without the owner asking for a check.

## ADDED Requirements

### Requirement: The audit is off unless switched on
The system SHALL audit no batch, write no audit row and send no message unless `AI_AUDIT_ENABLED` is `on`. Turning it on is an environment change; no code default or migration turns it on.

#### Scenario: Default environment
- **WHEN** `AI_AUDIT_ENABLED` is unset or `off` and an audit tick runs
- **THEN** it exits successfully without reading any batch, writes no audit row, sends no message and leaves no `ai_audit` heartbeat row

#### Scenario: Switched on without its credentials
- **WHEN** `AI_AUDIT_ENABLED` is `on` and `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` is unset (with a real LLM client)
- **THEN** the tick exits with an error naming the missing variable before auditing any batch

### Requirement: A batch is audited once it is finished by others and quiet
An audit tick SHALL audit every review batch that has as many finishers (reviewers with a verdict on every item) as its `reviews_needed`, has no holder, has at least one finisher other than the owner's code `bayanovea`, whose newest verdict is between 30 minutes and 7 days old, and has a verdict newer than its latest audit's watermark (or no audit yet).

#### Scenario: A finished batch
- **WHEN** an assessor other than the owner saved the last open verdict of a batch with `reviews_needed` 1 more than 30 minutes ago and the batch has no audit
- **THEN** the next tick audits it

#### Scenario: Still settling
- **WHEN** the batch's latest verdict is less than 30 minutes old
- **THEN** the tick skips it, and a later tick audits it

#### Scenario: Not finished
- **WHEN** a batch with `reviews_needed` 2 has one finisher, or has an open item, or is held by a reviewer
- **THEN** it is not audited

#### Scenario: Finished by the owner only
- **WHEN** every finisher of the batch is `bayanovea`
- **THEN** it is not audited

#### Scenario: No new verdicts
- **WHEN** the batch's latest verdict is not newer than its latest audit's watermark
- **THEN** it is not audited again

#### Scenario: A verdict changed after the audit
- **WHEN** a finisher changes a verdict of an audited batch
- **THEN** a tick at least 30 minutes later audits it again as a new audit row, and the earlier row stays unchanged

#### Scenario: A batch finished before the switch
- **WHEN** a finished batch's newest verdict is older than 7 days
- **THEN** no tick audits it, so switching the audit on does not audit the whole history

### Requirement: A batch can be audited by hand
`ai audit <batch>` SHALL audit that one batch now, ignoring the switch, the owner-only rule, the 30-minute settle, the 7-day window and the watermark, and SHALL record and notify like a tick; it SHALL refuse a batch that is not finished, and SHALL write no heartbeat.

#### Scenario: An old batch by hand
- **WHEN** the owner runs `ai audit <batch>` on a batch finished two weeks ago
- **THEN** an audit row is written and its new `owner` / `backlog` findings are sent

#### Scenario: An unfinished batch by hand
- **WHEN** the batch has an open item
- **THEN** the command exits 1 naming the reason and writes nothing

### Requirement: The audit only reads review and AI data
An audit SHALL NOT write verdicts, items, batches, video flags, AI rows or anything a viewer is served; it SHALL write only its own audit row and send its message. Every number it reports SHALL come from one consistent read of the batch.

#### Scenario: Audit of an ai batch
- **WHEN** a batch of ai items is audited
- **THEN** its items, verdicts, batch row and the AI rows of its videos are byte-for-byte the same after the tick

### Requirement: Rule findings
An audit SHALL compute these findings by fixed rules, each with the codes of the items it is about and its numbers as evidence: `eval_ready`, `judge_false_alarm`, `rubber_stamp`, `precision`, `agreement`, `category_flip`, `bounds`, `track_mismatch` (severities and conditions in the scenarios). A rule whose condition does not hold produces no finding.

#### Scenario: A sheet batch for the eval
- **WHEN** the batch holds items imported from an md sheet
- **THEN** an `eval_ready` finding of severity `owner` names the sheet, with action `eval_import`

#### Scenario: The judge sent a video whose entries were all kept
- **WHEN** every item of one video in the batch came from a judge `review` or `withdraw` and every item's latest verdict is a keep
- **THEN** a `judge_false_alarm` finding of severity `backlog` names those items and carries the judgement's decision, author (`rules` or `llm`) and reason, with action `backlog_item`

#### Scenario: Fast confirmations without a trace
- **WHEN** one finisher has at least 10 verdicts in the batch, the median gap between their consecutive verdicts is under 20 seconds, and none of their verdicts is `not_ad` or `unclear`, carries bounds or a comment
- **THEN** a `rubber_stamp` finding of severity `owner` names the reviewer, the median gap and the share under 20 seconds, with action `blind_subset` on that batch and a sample of at most 12 items

#### Scenario: A served segment judged not an ad
- **WHEN** an item sampled from served entries (`ai-served` items) has the latest verdict `not_ad` or `unclear`
- **THEN** a `precision` finding of severity `owner` names those items, with the keep share and its 95% lower bound

#### Scenario: Precision of a sample without errors
- **WHEN** the batch holds ai items and none of the condition above holds
- **THEN** a `precision` finding of severity `info` carries the keep share per proposed category and its 95% lower bound

#### Scenario: Two reviewers disagree
- **WHEN** the batch has two or more finishers and their latest verdicts differ on some items
- **THEN** an `agreement` finding names those items, of severity `owner` when the agreement is under 80% and `info` otherwise

#### Scenario: Category changed by the verdict
- **WHEN** a keep verdict's category differs from the item's single proposed category
- **THEN** a `category_flip` finding of severity `info` names those items and counts each direction

#### Scenario: Bounds and track flags
- **WHEN** the batch has keep verdicts, or items whose video's latest `track_mismatch` is true
- **THEN** a `bounds` finding of severity `info` carries how many keeps set bounds, and a `track_mismatch` finding of severity `info` names the flagged items

### Requirement: The model reads the comments and adds findings
An audit SHALL make one model call (`AI_AUDIT_MODEL`) with the batch's items, verdicts, comments and rule findings, and SHALL keep from its answer only a one-sentence summary and findings of kind `comment` or `other` that name at least one item code of the batch. The model SHALL NOT change a rule finding.

#### Scenario: A comment that needs the owner
- **WHEN** an assessor's comment reports a problem with the page, a rule question or a time typed into the comment
- **THEN** the answer's `comment` finding is recorded with its severity, items and text

#### Scenario: A finding naming no item of the batch
- **WHEN** a model finding names no item code, or a code outside the batch
- **THEN** that finding is dropped and the others are kept

#### Scenario: An answer that does not parse
- **WHEN** the model's answer fails the schema
- **THEN** the audit row is written with the rule findings only and the error, and the batch is not audited again until it has newer verdicts

#### Scenario: The call fails
- **WHEN** the model call returns a transport error
- **THEN** no audit row is written for the batch, the tick counts it as failed, and the next tick audits it again

### Requirement: Every audit is recorded
Each audit SHALL be one append-only row with the batch, the watermark (its newest verdict), the metrics, every finding (`kind`, `severity` `owner`|`backlog`|`info`, `items`, `text`, `evidence`, `action`, and whether it is new against the batch's previous audit), the summary, the model, the prompt's sha, the raw answer, usage, cost and any model error. A finding is new when the previous audit has no finding of the same kind on the same items. Rows are never deleted.

#### Scenario: Re-audit with the same findings
- **WHEN** a batch is audited again and every `owner` / `backlog` finding was already in its previous audit
- **THEN** the new row marks them not new

### Requirement: The owner sees new findings on the batch list
With `reviewer=bayanovea`, `/admin/review` SHALL show a findings block: for each batch, its latest audit if that audit has a new `owner` or `backlog` finding and is not hidden, with the summary and those findings. For any other reviewer the page SHALL show no block. A "Hide" action SHALL set who hid the audit and when, after which the audit leaves the block.

#### Scenario: Another reviewer
- **WHEN** an assessor opens their batch list
- **THEN** the page and its JSON carry no audit data

#### Scenario: Hide
- **WHEN** the owner hides an audit
- **THEN** the audit row records `hidden_by` `bayanovea` and the time, and the block no longer shows it

#### Scenario: Hide by another code
- **WHEN** the hide request carries a reviewer other than `bayanovea` or an unknown audit id
- **THEN** it is refused and nothing changes

### Requirement: The owner gets one message per new finding
After an audit row with a new `owner` or `backlog` finding is written, the system SHALL send one plain-text message to `TELEGRAM_CHAT_ID` naming the batch and each such finding's severity, items and text, and SHALL mark the row as notified. The message SHALL NOT contain `AUTH_TOKEN`. A failed send SHALL be retried on later ticks until it succeeds; a sent row is never sent again.

#### Scenario: Only info findings
- **WHEN** an audit has only `info` findings or no new ones
- **THEN** no message is sent

#### Scenario: Telegram unavailable
- **WHEN** the send fails
- **THEN** the row stays unnotified, the tick counts a failure, and the next tick sends it

### Requirement: The audit reports its health and cost
Every switched-on tick SHALL write the `ai_audit` heartbeat (failed = batches whose audit or message failed), and the model's cost SHALL be reported as the cost kind `audit`.

#### Scenario: A tick with a failed call
- **WHEN** one batch's model call fails
- **THEN** the heartbeat records one failed batch and no success time for that tick
