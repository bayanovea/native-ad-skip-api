# ai-verdict-application Specification

## Purpose
Defines how an assessor's verdict on an ai review item changes the AI row's served and hidden entries, here the rule for a keep whose bounds cover other served entries.

## ADDED Requirements

### Requirement: A keep covering same-category served entries absorbs them
When a keep verdict with bounds covers other served entries of the verdict's category entirely (each covered entry starts at or after the new start and ends at or before the new end), the system SHALL replace the item's entry and every covered entry with one served entry at the verdict's bounds, marked as set by review, with the rating of the votes on the new bounds. Hidden entries are not absorbed.

#### Scenario: Three sponsor pieces become one
- **WHEN** the row serves sponsor entries 1237–1245, 1258–1275, 1286–1294 and 1344–1378, and a sponsor keep with bounds 1237–1297 is saved on the item of 1258–1275
- **THEN** the row serves sponsor 1237–1297 (`source: review`) and 1344–1378 only, in start order, and the save succeeds

#### Scenario: Rating comes from the votes on the new bounds
- **WHEN** absorbed entries carried votes and no vote exists on the new bounds
- **THEN** the merged entry has no rating; the absorbed entries' votes count nowhere

#### Scenario: The hidden list is untouched
- **WHEN** a hidden entry lies inside the new bounds (other than one at exactly the new bounds, which gives way as today)
- **THEN** it stays in `hidden` with its reason

#### Scenario: Absorbed entries' items become history
- **WHEN** an absorbed entry had its own review item
- **THEN** a later verdict on that item changes no entry (its effective bounds find none), and only the merging item's verdict drives the merged entry

### Requirement: A partial overlap or another category is still refused
A keep whose bounds overlap a served entry without covering it entirely, or cover a served entry of another category, SHALL be refused with the `bounds_overlap` error and nothing written.

#### Scenario: Partial overlap
- **WHEN** the row serves sponsor 1258–1275 and a sponsor keep with bounds 1237–1270 is saved on another item
- **THEN** the save fails with `bounds_overlap` and the row is unchanged

#### Scenario: Covered entry of another category
- **WHEN** the row serves self_promotion 1258–1275 and a sponsor keep with bounds 1237–1297 is saved on another item
- **THEN** the save fails with `bounds_overlap` and the row is unchanged

### Requirement: The review page warns before an absorbing save
On an ai item with an AI row, the review page SHALL know the row's served entries and, while the typed or selected bounds cover other served entries of the chosen keep category, SHALL show how many segments the save will merge into this one and that their votes are lost. The warning never blocks the save.

#### Scenario: Bounds cover two neighbours
- **WHEN** the assessor enters bounds that cover two other served entries of the chosen category
- **THEN** the page shows the absorb warning naming 2 segments, and the save flash repeats it

#### Scenario: Bounds cover nothing
- **WHEN** the bounds overlap no other served entry
- **THEN** no absorb warning is shown

### Requirement: The decide response reports the absorbed count
The decide response of a keep verdict SHALL say how many served entries were absorbed (`absorbed`, 0 when none), so a client or a test can tell a merge from a plain move.

#### Scenario: Merge response
- **WHEN** a keep absorbs two entries
- **THEN** the response has `ai_applied: true` and `absorbed: 2`
