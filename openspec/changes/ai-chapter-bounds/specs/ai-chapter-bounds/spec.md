# Spec Delta

## Purpose
Defines how the author's own video chapters refine the bounds of served AI entries: a chapter that agrees with an entry at both edges gives it its bounds, an ad-titled chapter that agrees at one edge sends the entry to an assessor with the chapter's bounds on offer, and nothing is served on a chapter alone.

## ADDED Requirements

### Requirement: Every run stores the video's chapters
The system SHALL store, on each detector run, the chapters (start, end, title) the video's metadata reports at fetch time, as an empty list when it reports none, whatever `AI_CHAPTERS_ENABLED` says.

#### Scenario: Video with chapters, switch off
- **WHEN** `AI_CHAPTERS_ENABLED` is unset or `off` and a video whose metadata has three chapters is fetched
- **THEN** its run carries the three chapters and the video is published exactly as before this change

#### Scenario: Video without chapters
- **WHEN** the metadata has no chapters
- **THEN** the run carries an empty chapter list

#### Scenario: Answer resolved on a later tick
- **WHEN** a video was submitted in a batch on one tick and its answer arrives on a later tick
- **THEN** the chapter check uses the chapters stored on the run, with no new metadata fetch

### Requirement: The chapter check is off unless switched on
The system SHALL change no entry and send no chapter review item unless `AI_CHAPTERS_ENABLED` is `on`. Turning it on is an environment change; no code default or migration turns it on.

#### Scenario: Default environment
- **WHEN** `AI_CHAPTERS_ENABLED` is unset or `off` and a served entry 311–431 has a chapter 307–437
- **THEN** the entry is served at 311–431 with `source: "ai"` and no review item is created

### Requirement: An entry agreeing with a chapter at both edges takes the chapter's bounds
With `AI_CHAPTERS_ENABLED` on, an entry that passes every serving rule (confidence, `AI_MIN_SEGMENT_SECONDS`, the second opinion when on) SHALL be served at the bounds of a chapter that overlaps it with start and end each within `AI_CHAPTER_EDGE_SECONDS` of the entry's, rounded inward to whole seconds, with `source: "chapter"` and its own category and confidence; the title plays no part.

#### Scenario: Switch off
- **WHEN** `AI_CHAPTERS_ENABLED` is unset or `off`
- **THEN** every served entry keeps the bounds the detector rules gave it

#### Scenario: Both edges near
- **WHEN** a served sponsor entry is 311–431 and a chapter "Реклама" runs 307–437, with `AI_CHAPTER_EDGE_SECONDS` 10
- **THEN** the entry is served as sponsor 307–437 with `source: "chapter"` and no review item is created

#### Scenario: A chapter whose title does not name an ad
- **WHEN** a served entry is 239–334 and a chapter "Обзор геймпада" runs 236–338
- **THEN** the entry is served at 236–338 with `source: "chapter"`

#### Scenario: Votes already on the chapter bounds
- **WHEN** an entry moves to 307–437 and two users already voted up on sponsor 307–437 of that video
- **THEN** the published entry carries rating 2

### Requirement: Chapter bounds never break the serving rules
A chapter's bounds SHALL replace an entry's only when they are at least `AI_MIN_SEGMENT_SECONDS` long and overlap no other served entry; otherwise the entry SHALL keep its own bounds. Of several qualifying chapters the one with the smallest total edge distance SHALL be used. Hidden entries SHALL never take chapter bounds.

#### Scenario: Switch off
- **WHEN** `AI_CHAPTERS_ENABLED` is unset or `off`
- **THEN** no entry takes chapter bounds, whatever its chapters

#### Scenario: Chapter bounds overlapping another served entry
- **WHEN** a served entry 100–150 has a chapter 95–158 and another served entry runs 155–200
- **THEN** the entry stays at 100–150 with `source: "ai"`

#### Scenario: Chapter shorter than the length rule
- **WHEN** a served entry is 50–58, a chapter runs 52–55 and `AI_MIN_SEGMENT_SECONDS` is 5
- **THEN** the entry stays at 50–58

#### Scenario: Hidden entries are left alone
- **WHEN** an entry is hidden with reason `confidence`, `short` or `unconfirmed` and a chapter matches it at both edges
- **THEN** the hidden entry keeps its bounds and reason

#### Scenario: Two qualifying chapters
- **WHEN** a served entry is 100–160 and chapters run 95–158 and 104–169
- **THEN** the entry is served at 95–158 (distance 7 against 13)

### Requirement: An ad-titled chapter agreeing at one edge sends the entry to review
With `AI_CHAPTERS_ENABLED` on, an entry that would be served and did not take a chapter's bounds SHALL keep its own bounds and get one `kind = 'ai'` review item when a chapter overlaps it with one edge within `AI_CHAPTER_EDGE_SECONDS` of the entry's, the other further, and a title matching the ad keyword list. A title alone SHALL never change what is served.

#### Scenario: Switch off
- **WHEN** `AI_CHAPTERS_ENABLED` is unset or `off`
- **THEN** no `ai-chapter-*` item is created

#### Scenario: The chapter runs far past the ad
- **WHEN** a served entry is 1006–1076 and a chapter "Мегабожественная интеграция" runs 1008–1505
- **THEN** the entry is served at 1006–1076 with `source: "ai"` and a `T` item on 1006–1076 names the chapter 1008–1505

#### Scenario: A topic chapter ending where the ad ends
- **WHEN** a served entry is 2108–2127 and the only overlapping chapter, "Манты", runs 1909–2127
- **THEN** nothing changes and no item is created

#### Scenario: No edge near
- **WHEN** an ad-titled chapter overlaps a served entry with both edges further than `AI_CHAPTER_EDGE_SECONDS`
- **THEN** nothing changes and no item is created

#### Scenario: A verdict on the item
- **WHEN** an assessor keeps a `T` item with the chapter's bounds 1008–1505
- **THEN** the entry is served at 1008–1505 with `source: "review"`, as any keep with bounds on an ai item

### Requirement: A chapter review item carries the entry and the chapter
A chapter review item SHALL be in sheet `ai-chapter-<YYYY-MM-DD>` (UTC), with code `T<n>`, priority `important`, the entry's bounds and category, the transcript over the entry, a player link 2 s before its start and a `flagged_by` naming the chapter's title and bounds; an entry SHALL get at most one.

#### Scenario: Switch off
- **WHEN** `AI_CHAPTERS_ENABLED` is unset or `off`
- **THEN** no sheet `ai-chapter-*` exists for new publications

#### Scenario: Item fields
- **WHEN** a served sponsor entry 1341–1434 (high) is sent to review under the chapter "Реклама" 1337–1378 on 2026-11-05 UTC
- **THEN** an item `T<n>` in `ai-chapter-2026-11-05` (priority `important`) covers 1341–1434, proposes sponsor, and its `flagged_by`, shown after a verdict, names «Реклама» 22:17–22:58

#### Scenario: Two ad-titled chapters near one entry
- **WHEN** two ad-titled chapters each share one edge with the same served entry
- **THEN** the entry gets one item, naming the chapter with the smaller edge distance

### Requirement: The review page offers a run's chapters
On an ai item whose AI row's run has chapters, the item page SHALL list the chapters that overlap the transcript window, each with its title and player-format times, before and after a verdict, and SHALL let the assessor fill the verdict bounds from a chapter in one action; a verdict saved with such bounds SHALL record the bounds source `chapter`.

#### Scenario: Item with chapters
- **WHEN** an assessor opens a `T` item whose run has a chapter "Реклама" 22:17–22:58 inside the window
- **THEN** the page shows "Реклама 22:17 – 22:58" with a button that puts 22:17 and 22:58 into the bounds inputs

#### Scenario: Saving chapter bounds
- **WHEN** the assessor saves a sponsor verdict after filling the bounds from a chapter
- **THEN** the verdict row carries those bounds with bounds source `chapter`

#### Scenario: Sheet item or a run without chapters
- **WHEN** the item is a sheet item, or its run has no chapters
- **THEN** no chapter list is shown

### Requirement: Chapter outcomes are visible
The system SHALL log, per published video, how many entries took chapter bounds and how many chapter review items it sent; the admin video page SHALL mark an entry served at chapter bounds.

#### Scenario: Publish log
- **WHEN** a video is published with one entry moved to a chapter and one sent to review
- **THEN** its publish log line says so

#### Scenario: Admin page
- **WHEN** the owner opens `/admin/video/:video_id` for a row with a `source: "chapter"` entry
- **THEN** that entry shows a "chapter" badge
