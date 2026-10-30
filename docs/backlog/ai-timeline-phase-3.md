---
worth: later
where: docs/plans/completed/20261022-ai-first-segments.md (Phase 3 design)
added: 2026-10-22
---
# AI phase 3: audio drift (subtitle timelines off from the video)

About 1 video in 5 has a prv auto-subtitle timeline off by more than 2 s (steps and offsets of 15–90 s). The detector refuses them with a binary gate (last cue end − duration > 3 s → `timeline_unreliable`), which misses some bad tracks and drops good videos. Phase 3 measures the shift from the audio (whisper.cpp on short windows) and re-times the AI entries through it; the design is in the plan's "Phase 3 design" section, the `prv_ai_timelines` table exists with no writer.

Next step is not code: the owner runs the timeline spike on the prod host or a VM of the same size (the plan's Post-Completion → "Timeline spike": `scripts/timeline-spike/`, five audited videos, CPU seconds, RAM and shift accuracy against `~/Web/data/audit/drift.jsonl`), writes `docs/research/20261022-timeline-spike.md`, and the phase-3 plan starts from that note.

Why `later`: it waits for the spike and for week-1 numbers on how many popular videos the gate refuses.

Numbers so far (2026-10-30, 1222 videos through the model since 2026-10-24): the last-cue gate refused 22 (1.8 %), 10 of them in the last 200 runs; the duration gate another 31 (`ai-detect-duration-mismatch-rising.md`). The gate sees only an overrun at the end, so 1.8 % is a floor for drifted tracks, not the 1-in-5 rate of the audit.
