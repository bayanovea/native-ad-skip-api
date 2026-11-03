---
worth: later
where: scripts/import-below-threshold.js:86 (hiddenItems)
added: 2026-11-04
auto: yes
---
# The below-threshold importer re-sends hidden entries an assessor already decided

`hiddenItems` skips a hidden entry when `reviewRepository.hasItemAt` finds an item at its bounds, matched on the item's own `start` / `end`. A keep with bounds moves the entry (`source: "review"`), so the deciding item's own bounds no longer match it. When those bounds are under `AI_MIN_SEGMENT_SECONDS`, the entry sits in `hidden` as `short`, and a run with `--min-seconds` below the threshold (e.g. `--min-seconds 0`) sends it to the assessors again as a `B` item, though a human already set its bounds. The `--served` path already leaves out `source: "review"` entries; the hidden path does not.

Failing scenario (read from the code): a `D` item on `sponsor 300–320 unconfirmed`, verdict `sponsor` with bounds 305–308 → `hidden` `[sponsor 305–308, source review, reason short]`; `import-below-threshold.js --min-seconds 0` → `hasItemAt({305, 308})` finds nothing (the `D` item is at 300–320) → a new `B1` on 305–308.

Approach: in `hiddenItems` skip entries with `e.source === 'review'`, as `servedItems` does: an assessor set their bounds, so they have a decided item. Test: the e2e `import-below-threshold:` test gets a hidden `short` entry with `source: "review"` that a `--min-seconds 0` run leaves out.
