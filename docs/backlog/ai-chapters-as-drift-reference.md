---
worth: later
where: ai/pipeline/detect.go:424
added: 2026-11-02
---
# AI: chapters as a timeline reference for drifted subtitle tracks

Chapters are the author's timecodes on the video's own timeline, so they do not drift with the
auto subtitle track. Today a video whose track overruns the video by more than 3 s is refused
(`timeline_unreliable`, 22 of 1222 runs by 2026-10-30) and phase 3 plans to measure the shift from
the audio (`ai-timeline-phase-3.md`, whisper.cpp on the prod host, waiting for a spike).

On a video with chapters the shift could be read without audio: chapter starts against the cue
times where the topic changes (or where an ad's words begin), giving a step function of offsets
like the one phase 3 wants in `prv_ai_timelines.steps`. Since 2026-11-02 every run stores its
chapters (`prv_ai_runs.chapters`), but a refused video gets no run row today, so the chapters of
`timeline_unreliable` videos are not kept; storing them there too is the first step.

Open: how many refused videos have chapters (31 % of the eval corpus has them, the refused ones may
differ), and whether a chapter-derived shift is accurate enough (compare with the drift audit,
`~/Web/data/audit/drift.jsonl`). Precision-first still holds: a shift from chapters re-times AI
entries, it never serves a chapter alone.

Settles it: the count of refused videos with chapters and one manual comparison of a chapter-derived
shift with the audit on a few videos; then fold it into the phase-3 plan or drop it.
