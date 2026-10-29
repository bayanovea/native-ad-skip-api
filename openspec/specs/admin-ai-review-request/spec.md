# admin-ai-review-request Specification

## Purpose
Defines how the operator sends one entry of a video's AI row to assessor review from the admin video page, and how the page shows what is already in review.

## Requirements

### Requirement: Any entry of the AI row can be sent to review
The admin video page SHALL offer, on every served and hidden entry of the AI row, a confirm action that creates one ai review item on that entry: the item's bounds and category are the entry's, its cues the run's transcript over the bounds, its link the player at start − 2 s, and its origin recorded as sent by the admin with the entry's category, confidence, length and state. The row's state (published or withdrawn) does not matter.

#### Scenario: Served entry sent
- **WHEN** the operator confirms "send to review" on a served sponsor entry 1258–1275 of a published row
- **THEN** one ai item exists on that row with bounds 1258–1275, `proposed` sponsor, and the response names its batch and code

#### Scenario: Hidden entry sent
- **WHEN** the operator confirms it on a hidden entry
- **THEN** an ai item is created the same way, and a later keep verdict on it serves the entry as any keep on a hidden entry does

#### Scenario: Withdrawn row
- **WHEN** the row was withdrawn by the judge
- **THEN** the item is still created, and keep verdicts can restore the row as today

### Requirement: The item goes to today's urgent admin batch, placed like the judge's
The item SHALL belong to the sheet `ai-admin-<YYYY-MM-DD>` (UTC) with codes `M<n>` by position, in the sheet's newest part that nobody holds and nobody has a verdict in with room within 30 items, else a new part named the importer's way (`<sheet>`, then `<sheet>-p2`, …), registered `urgent` with one review needed.

#### Scenario: First item of the day
- **WHEN** no `ai-admin-<today>` batch exists
- **THEN** the item is `M1` in batch `ai-admin-<today>`, priority `urgent`, and the batch is available on the review list

#### Scenario: Someone holds today's part
- **WHEN** a reviewer holds `ai-admin-<today>` and another entry is sent
- **THEN** the item goes to a new part `ai-admin-<today>-p2`, so the held batch never grows

### Requirement: An entry with an open item is not sent twice
When the entry already has an ai item without a verdict at its bounds, the action SHALL be refused with a conflict naming that item's batch and code, and nothing is written.

#### Scenario: Open judge item
- **WHEN** the judge sent the entry to `ai-judge-<date>` and nobody decided it, and the operator sends it again
- **THEN** the response is a 409 naming `ai-judge-<date>` and its code, and no new item exists

#### Scenario: Decided item
- **WHEN** the entry's only item is in a finished batch with a verdict
- **THEN** a new item is created in `ai-admin-<today>`

### Requirement: Auth and errors match the withdraw link
The action SHALL take the admin token as `verifyBearerToken` in the query, refuse every request when the token is unset or wrong (401), answer 400 on a non-numeric video id or malformed bounds, and 404 when the video has no AI row or no entry at those bounds.

#### Scenario: Wrong token
- **WHEN** the link is called with a wrong token
- **THEN** 401 and nothing written

#### Scenario: No entry at the bounds
- **WHEN** the bounds match no served or hidden entry
- **THEN** 404

### Requirement: The AI block shows what is in review
Each entry of the AI block SHALL show the batch and code of its open ai item when it has one, and the send action only when it has none; after a successful send the page reflects the new item.

#### Scenario: Entry already in review
- **WHEN** an entry has an open item `A3` in `ai-judge-2026-10-29`
- **THEN** its row shows `ai-judge-2026-10-29 A3` and no send button

#### Scenario: Entry sent from the page
- **WHEN** the operator sends an entry and the page reloads
- **THEN** that entry's row shows the new batch and code
