# Spec Delta

## MODIFIED Requirements

### Requirement: A partial overlap or another category is still refused
A keep whose bounds overlap a served entry without covering it entirely, or cover a served entry of another category, SHALL be refused with the `bounds_overlap` error and nothing written. The exception is a keep on an entry that is not served, with bounds lying inside a wider served entry of any category: the stretch is served already, so the save SHALL succeed and change no entry. Served entries with `source: "user"` are not counted here.

#### Scenario: Partial overlap
- **WHEN** the row serves sponsor 1258–1275 and a sponsor keep with bounds 1237–1270 is saved on another item
- **THEN** the save fails with `bounds_overlap` and the row is unchanged

#### Scenario: Covered entry of another category
- **WHEN** the row serves self_promotion 1258–1275 and a sponsor keep with bounds 1237–1297 is saved on another item
- **THEN** the save fails with `bounds_overlap` and the row is unchanged

#### Scenario: A hidden entry inside a wider served one
- **WHEN** the row serves sponsor 100–200 and hides sponsor 150–160, and a keep is saved on the hidden entry's item
- **THEN** the save succeeds, the row is unchanged and the entry stays hidden

#### Scenario: Partial overlap with an unverified user entry
- **WHEN** the row serves a `source: "user"` self_promotion 1260–1300 and a sponsor keep with bounds 1237–1270 is saved on another item
- **THEN** the save succeeds, the row serves sponsor 1237–1270 and the user entry is gone

## ADDED Requirements

### Requirement: An unverified user entry gives way to a keep
A keep SHALL remove every served `source: "user"` entry its bounds overlap, whatever the category and however far they overlap, other than the entry the verdict is on: an assessor's bounds take precedence over a segment nobody checked. Such an entry of the keep's category lying entirely inside the bounds counts in `absorbed`.

#### Scenario: A keep on the model's hidden entry under a shown user segment
- **WHEN** the row serves a user sponsor 100–160 and hides the model's sponsor 105–150 as `unconfirmed`, and a keep is saved on the hidden entry's item
- **THEN** the row serves sponsor 105–150 and the user entry is gone

### Requirement: A keep makes a user entry the reviewer's
A keep on a served `source: "user"` entry SHALL leave it served with `source: "review"`, also when the verdict moves neither its bounds nor its category, so that nothing treats it as unverified afterwards. A keep on a user segment's item that finds no entry at its bounds SHALL create the entry with `source: "review"`, absorbing covered served entries of its category as any keep does.

#### Scenario: Keep without bounds on a shown segment
- **WHEN** an assessor answers `sponsor` on the `U` item of a served user entry 1453–1490
- **THEN** the row serves sponsor 1453–1490 with `source: "review"` and `ai_applied` is true

#### Scenario: Keep on a held segment
- **WHEN** the row serves sponsor 219–292, a `U` item sits on 219–334 with no entry there, and an assessor answers `sponsor` without bounds
- **THEN** the row serves one sponsor 219–334 (`source: "review"`), the response has `absorbed: 1`

### Requirement: A verdict on a glued entry settles its pieces
When a verdict is applied to a `source: "user"` entry, the entries hidden as `glued` that lie inside it SHALL follow the verdict: a keep drops them (the kept entry stands for them), `not_ad` / `unclear` set their reason to `review`, so that no later tick serves them again.

#### Scenario: Not an ad on a glued entry
- **WHEN** the row serves the glued sponsor 219–308 over the hidden `glued` sponsor 219–292, and an assessor answers `not_ad` on an item of 219–308
- **THEN** both 219–308 and 219–292 are hidden with reason `review`

#### Scenario: Keep on a glued entry
- **WHEN** an assessor answers `sponsor` on an item of the glued 219–308
- **THEN** the row serves sponsor 219–308 with `source: "review"` and hides no `glued` entry inside it

### Requirement: Withdraw and restore count the model's and reviewers' entries
A row SHALL be withdrawn by review when a `not_ad` / `unclear` leaves it without a served entry other than `source: "user"` ones, and a row withdrawn by the judge or by review SHALL be restored once every served entry other than `source: "user"` ones has a keep as its latest verdict decided after the withdraw, provided there is at least one.

#### Scenario: The last model entry goes, a user entry remains
- **WHEN** a row serves one model entry and one user intro, and a `not_ad` hides the model entry
- **THEN** the row is withdrawn by `review` and the human path serves the video

#### Scenario: Restore with a user entry in the row
- **WHEN** a judge-withdrawn row holds two model entries and one user entry, and both model entries get a keep
- **THEN** the row is served again, although the user entry has no verdict

#### Scenario: Only user entries left
- **WHEN** a withdrawn row's `data` holds nothing but user entries
- **THEN** no verdict restores it
