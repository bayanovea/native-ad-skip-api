# Spec Delta

## MODIFIED Requirements

### Requirement: A batch can be audited by hand
`ai audit <batch>` SHALL audit that one batch now, ignoring the switch, the owner-only rule, the 30-minute settle, the 7-day window and the watermark, and SHALL record, recount the cards and notify like a tick; it SHALL refuse a batch that is not finished, and SHALL write no heartbeat.

#### Scenario: An old batch by hand
- **WHEN** the owner runs `ai audit <batch>` on a batch finished two weeks ago
- **THEN** an audit row is written, the cards are recounted with its soft findings, and its new `strict` findings are sent

#### Scenario: An unfinished batch by hand
- **WHEN** the batch has an open item
- **THEN** the command exits 1 naming the reason and writes nothing

### Requirement: The audit only reads review and AI data
An audit SHALL NOT write verdicts, items, batches, video flags, AI rows or anything a viewer is served; it SHALL write only its own audit rows and cards and send its messages. Every number of one batch's audit SHALL come from one consistent read of that batch and its AI rows.

#### Scenario: Audit of an ai batch
- **WHEN** a batch of ai items is audited
- **THEN** its items, verdicts, batch row and the AI rows of its videos are byte-for-byte the same after the tick

### Requirement: Rule findings
An audit SHALL compute findings by fixed rules, each with the codes of the items it is about and its numbers as evidence, and a severity: `strict` (reaches the owner), `soft` (pooled by topic) or `info` (recorded only). Strict: the flow checks, `uniform_batch`, `fast_pace`, `llm_error_repeat`. Soft: `judge_false_alarm`, `track_mismatch`, `served_not_ad`. Info: `eval_ready`, `rubber_stamp`, `precision`, `category_flip`, `bounds`. A rule whose condition does not hold produces no finding.

#### Scenario: An ai item without its AI data
- **WHEN** an ai item's video has no AI row, or the AI row's run has no transcript or no cues
- **THEN** a `strict` finding `ai_item_no_row` or `ai_item_no_transcript` names the item

#### Scenario: A link that is not http(s)
- **WHEN** an item's stored link does not start with `http://` or `https://`
- **THEN** a `strict` finding `link_not_http` names the item

#### Scenario: An ai item past the end of its video
- **WHEN** an ai item starts after the longest known duration of its native_id's videos rows
- **THEN** a `strict` finding `ai_item_beyond_duration` names it with that duration; a sheet item in the same position produces no finding

#### Scenario: A keep that landed nowhere
- **WHEN** an ai item's latest verdict is a keep and its AI row has no `data` or `hidden` entry of the verdict's category at the item's effective bounds and no served entry of that category covering them
- **THEN** a `strict` finding `verdict_not_applied` names the item with its verdict and bounds

#### Scenario: A keep absorbed into a wider entry
- **WHEN** an ai item's latest verdict is a keep and a served entry of the same category covers its effective bounds
- **THEN** no `verdict_not_applied` finding is made for it

#### Scenario: A not_ad or unclear that landed nowhere
- **WHEN** an ai item's latest verdict is `not_ad` or `unclear` and its AI row has no `hidden` entry with reason `review` at the item's effective bounds
- **THEN** a `strict` finding `verdict_not_applied` names the item

#### Scenario: A withdrawn row that should be served again
- **WHEN** an AI row of the batch's videos is withdrawn by `judge` or `review`, has a non-empty `data`, every `data` entry has an ai item whose latest verdict is a keep decided after `withdrawn_at`, and the row is still withdrawn
- **THEN** a `strict` finding `withdrawn_all_kept` names those items

#### Scenario: A row withdrawn by the admin
- **WHEN** the same holds for a row withdrawn by `admin`
- **THEN** no `withdrawn_all_kept` finding is made

#### Scenario: The model failed twice in a row
- **WHEN** an audit's model answer fails the schema and the batch's previous audit also has a model error
- **THEN** a `strict` finding `llm_error_repeat` carries both errors

#### Scenario: A uniform batch
- **WHEN** a finisher other than `bayanovea` has latest verdicts on at least 10 items of the batch and at least 90% of them are `not_ad` or `unclear`
- **THEN** a `strict` finding `uniform_batch` names the reviewer with the counts

#### Scenario: Too fast to read
- **WHEN** a finisher other than `bayanovea` has at least 10 verdicts in the batch and the median gap between their consecutive verdicts is under 5 seconds
- **THEN** a `strict` finding `fast_pace` names the reviewer with the median gap

#### Scenario: Fast confirmations without a trace
- **WHEN** one finisher other than `bayanovea` has at least 10 verdicts in the batch, the median gap between their consecutive verdicts is under 20 seconds, and none of their verdicts is `not_ad` or `unclear`, carries bounds or a comment
- **THEN** an `info` finding `rubber_stamp` names the reviewer, the median gap and the share under 20 seconds

#### Scenario: The judge sent a video whose entries were all kept
- **WHEN** every item of one video in the batch came from a judge `review` or `withdraw` and every item's latest verdict is a keep
- **THEN** a `soft` finding `judge_false_alarm` with topic `judge_false_alarm` names those items and carries the judgement's decision, author (`rules` or `llm`) and reason

#### Scenario: A served segment judged not an ad
- **WHEN** an item sampled from served entries (`ai-served` items) has the latest verdict `not_ad` or `unclear`
- **THEN** a `soft` finding `served_not_ad` with topic `served_not_ad` names those items

#### Scenario: A sheet batch for the eval
- **WHEN** the batch holds items imported from an md sheet
- **THEN** an `info` finding `eval_ready` names the sheet and the batch

#### Scenario: Precision of a sample without errors
- **WHEN** the batch holds ai items with verdicts
- **THEN** an `info` finding `precision` carries the keep share per proposed category and its 95% lower bound

#### Scenario: Category changed by the verdict
- **WHEN** a keep verdict's category differs from the item's single proposed category
- **THEN** an `info` finding `category_flip` names those items and counts each direction

#### Scenario: Bounds and track flags
- **WHEN** the batch has keep verdicts, or items whose video's latest `track_mismatch` is true
- **THEN** an `info` finding `bounds` carries how many keeps set bounds, and a `soft` finding `track_mismatch` with topic `track_mismatch` names the flagged items

#### Scenario: Two reviewers disagree
- **WHEN** the batch has two finishers whose latest verdicts differ on some items
- **THEN** no finding is made for the disagreement

### Requirement: The model reads the comments and adds findings
An audit SHALL make one model call (`AI_AUDIT_MODEL`) with the batch's items, verdicts, comments, rule findings and the assessor rules taken from the review page's Russian strings, and SHALL keep from its answer only a one-sentence summary and `soft` findings of kind `comment` or `other` that name at least one item code of the batch and a topic from the fixed list. The model SHALL NOT change a rule finding.

#### Scenario: A comment that needs the owner
- **WHEN** an assessor's comment reports a problem with the page or a time typed into the comment
- **THEN** the answer's finding is recorded as `soft` with its topic, items and text

#### Scenario: A keep the text names no payer for
- **WHEN** a keep verdict's cues name no payer and the verdict is otherwise consistent with the page's rules
- **THEN** the prompt directs the model not to report it, since the video decides (owner, 2026-11-02)

#### Scenario: A not_ad between kept neighbours
- **WHEN** a `not_ad` / `unclear` verdict is otherwise consistent with the page's rules and the only ground to doubt it is that neighbouring items of the same video were kept
- **THEN** the prompt directs the model not to report it: the assessor saw the video, the audit reads text only, and the pieces of one detected ad are separate stretches (owner, 2026-11-03, D17 of `ai-second-2026-11-02`)

#### Scenario: The page's rules change
- **WHEN** a rule string the prompt includes changes in `prv/locales/review/ru.json`
- **THEN** the next audit sends the new text and its recorded prompt sha differs

#### Scenario: Topic `other`
- **WHEN** a model finding has topic `other`
- **THEN** it is kept only with a short name, which the pool groups by

#### Scenario: A finding naming no item of the batch
- **WHEN** a model finding names no item code, a code outside the batch, or a topic outside the list
- **THEN** that finding is dropped and the others are kept

#### Scenario: An answer that does not parse
- **WHEN** the model's answer fails the schema
- **THEN** the audit row is written with the rule findings only and the error, and the batch is not audited again until it has newer verdicts

#### Scenario: The call fails
- **WHEN** the model call returns a transport error
- **THEN** no audit row is written for the batch, the tick counts it as failed, and the next tick audits it again

### Requirement: Every audit is recorded
Each audit SHALL be one append-only row with the batch, the watermark (its newest verdict), the metrics, every finding (`kind`, `severity` `strict`|`soft`|`info`, `topic` for soft findings, `items`, `text`, `evidence`, `action`, and whether it is new against the batch's previous audit), the summary, the model, the prompt's sha, the raw answer, usage, cost and any model error. A finding is new when the previous audit has no finding of the same kind on the same items. Rows are never deleted.

#### Scenario: Re-audit with the same findings
- **WHEN** a batch is audited again and every `strict` finding was already in its previous audit
- **THEN** the new row marks them not new

#### Scenario: Rows of the first prod tick
- **WHEN** an audit row written before this change holds `owner` / `backlog` findings without a topic
- **THEN** it stays as it is, reaches neither the block nor the ping, and the pool ignores its findings

### Requirement: The owner sees new findings on the batch list
With `reviewer=bayanovea`, `/admin/review` SHALL show a findings block: for each batch its latest audit if that audit has a new `strict` finding and is not hidden, with the summary and those findings; then the visible export lines and the visible pattern and reviewer cards. For any other reviewer the page SHALL show no block. Hiding an audit SHALL record who and when, after which it leaves the block.

#### Scenario: Another reviewer
- **WHEN** an assessor opens their batch list
- **THEN** the page and its JSON carry no audit or card data

#### Scenario: Only soft and info findings
- **WHEN** a batch's latest audit has no new `strict` finding
- **THEN** the block shows no entry for that audit, whatever its soft and info findings

#### Scenario: Hide
- **WHEN** the owner hides an audit
- **THEN** the audit row records `hidden_by` `bayanovea` and the time, and the block no longer shows it

#### Scenario: Hide by another code
- **WHEN** the hide request carries a reviewer other than `bayanovea` or an unknown audit id
- **THEN** it is refused and nothing changes

### Requirement: The owner gets one message per new finding
With `AI_AUDIT_TELEGRAM` `on`, the system SHALL send one plain-text message to `TELEGRAM_CHAT_ID` for each audit row with a new `strict` finding (the batch and each such finding's items and text) and for each pattern or reviewer card that became visible, and SHALL mark it notified. Export lines are never sent. No message SHALL contain `AUTH_TOKEN`. A failed send SHALL be retried on later ticks (last 7 days) until it succeeds; a sent one is never sent again.

#### Scenario: Ping switched off
- **WHEN** `AI_AUDIT_TELEGRAM` is unset or `off` and an audit has a new `strict` finding or a card becomes visible
- **THEN** no message is sent, no Telegram variable is needed, nothing is marked notified, the tick counts no failure, and the page block shows them

#### Scenario: Only info findings
- **WHEN** an audit has only `soft` and `info` findings or no new ones, and no card became visible
- **THEN** no message is sent

#### Scenario: A pattern card appears
- **WHEN** a topic crosses the pattern threshold
- **THEN** one message names the topic, its counts and examples

#### Scenario: Telegram unavailable
- **WHEN** the send fails
- **THEN** the row or card stays unnotified, the tick counts a failure, and the next tick sends it

## ADDED Requirements

### Requirement: Soft findings are pooled into pattern cards
After every audit row (tick or manual run), the system SHALL count the `soft` findings of each batch's latest audit of the last 30 days by topic (topic `other` by its name), as distinct items and batches. A topic with at least 5 items in at least 3 batches SHALL be one pattern card with the counts, 3 to 5 example items linked to the review page, and the suggested action.

#### Scenario: A topic below the threshold
- **WHEN** a topic has 4 items in 3 batches, or 6 items in 2 batches
- **THEN** no card is shown for it

#### Scenario: A topic crosses the threshold
- **WHEN** a re-audit brings a topic to 5 items in 3 batches
- **THEN** a pattern card for the topic appears in the owner block

#### Scenario: A re-audited batch
- **WHEN** a batch is audited again
- **THEN** only its latest audit counts, so its items are not counted twice

#### Scenario: Switch off
- **WHEN** `AI_AUDIT_ENABLED` is unset or `off` and a tick runs
- **THEN** no card is recounted or written

### Requirement: A hidden card comes back only on new evidence
Every card SHALL have a hide action, owner only, that records who, when and what the card counted. A hidden pattern card SHALL come back when its topic has at least 5 items not counted at the hide in at least 3 batches not counted at the hide; a hidden reviewer card when the reviewer's pace or keep share changed (see its requirement); a hidden export line when its sheet has more finished parts than at the hide.

#### Scenario: Hide a pattern card
- **WHEN** the owner hides a pattern card and two more items of its topic arrive
- **THEN** the card stays hidden

#### Scenario: Enough new items
- **WHEN** after the hide 5 new items of the topic arrive in 3 batches that were not counted at the hide
- **THEN** the card is visible again with the current counts

#### Scenario: Hide by another code
- **WHEN** the card hide request carries a reviewer other than `bayanovea` or an unknown card id
- **THEN** it is refused and nothing changes

### Requirement: One card per reviewer for fast confirmations
The system SHALL keep one reviewer card per reviewer who has a `rubber_stamp` finding in a batch's latest audit of the last 30 days, with the number of such batches, their median gap and the reviewer's keep share over their latest verdicts of the last 30 days. A hidden reviewer card SHALL come back only when the median gap moved by at least 25% or the keep share by at least 10 points from the values at the hide.

#### Scenario: The same pace every day
- **WHEN** a hidden reviewer card's reviewer gets a `rubber_stamp` finding in a new batch at a median gap within 25% of the hidden one and a keep share within 10 points
- **THEN** the card stays hidden

#### Scenario: Faster than before
- **WHEN** the reviewer's median gap drops from 13 s at the hide to 9 s
- **THEN** the card is visible again with the new numbers

### Requirement: One export line per sheet
The system SHALL show one export line per sheet that has an `eval_ready` finding in an audit, naming the sheet and how many of its parts are finished of how many, in place of a per-batch eval finding. Hiding the line means the sheet was exported.

#### Scenario: A sheet cut into parts
- **WHEN** two of a sheet's three parts are finished and audited
- **THEN** the block shows one line for the sheet with 2 of 3 parts finished

#### Scenario: A part finished after the export
- **WHEN** the owner hid the line at 2 of 3 parts and the third part is finished and audited
- **THEN** the line is visible again with 3 of 3
