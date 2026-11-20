# Spec Delta

## Purpose

Defines which stored viewer signals the judge counts for a published AI row and which of them count as new evidence
that makes an already judged video due again, so that collecting a signal and acting on it are separate decisions.

## ADDED Requirements

### Requirement: Skips are counted next to undos
For every served AI entry the judge SHALL count the `interval_skip` rows on the entry's exact `(category_id, start,
end)` for the video's `native_id` up to the tick's start (`skips`), store it in the judgement's signals and counters,
and give the LLM judge the undo count per skip next to the counts per 1000 views.

#### Scenario: Counted
- **WHEN** an AI entry has 40 `interval_skip` rows and 2 `interval_undo` rows on its bounds
- **THEN** the judgement's signals show `skips: 40`, `undo: 2`, and the LLM request states 2 undos in 40 skips

#### Scenario: Other bounds
- **WHEN** skip rows exist on the video for bounds that match no served AI entry
- **THEN** they are not counted

#### Scenario: Old rows
- **WHEN** a video has undo rows but no skip rows (clients before this change)
- **THEN** `skips` is 0 and the undo rate per skip is omitted from the LLM request

### Requirement: Undo is counted by any means
The judge's `undo` count SHALL include `interval_undo` rows of every `via` (`button`, `seek`, NULL).

#### Scenario: Seek undo
- **WHEN** an entry has one undo row with `via: "seek"` and one with `via: "button"`
- **THEN** `undo` is 2

### Requirement: Undo as new evidence is switchable
With `AI_JUDGE_UNDO_EVIDENCE` unset or `on`, an undo row created after an entry's baseline SHALL be new evidence, as
today. With it `off`, undo rows SHALL still be counted in `signals` and `signals.new`, but alone SHALL NOT make a
judged video due or send a first judgement to the LLM: a video whose only new negative signal is undo is `ok` by
`rules` with reason `no negative signal (undo counted only)`.

#### Scenario: Switch unset
- **WHEN** `AI_JUDGE_UNDO_EVIDENCE` is unset and a judged video gets one undo on a served entry
- **THEN** the video is due at the next tick and the LLM judges it, as before this change

#### Scenario: Switch off, undo only
- **WHEN** `AI_JUDGE_UNDO_EVIDENCE` is `off` and a published video's only new signal is two undos
- **THEN** the judgement is `ok` by `rules`, no LLM call is made, no review item is written, and `signals.new.undo`
  is 2

#### Scenario: Switch off, undo and a down vote
- **WHEN** `AI_JUDGE_UNDO_EVIDENCE` is `off` and a video has a new undo and a new down vote
- **THEN** the LLM judges it and its request shows both counts

#### Scenario: Invalid value
- **WHEN** `AI_JUDGE_UNDO_EVIDENCE` is `maybe`
- **THEN** `ai judge` exits 1 naming the variable
