---
worth: yes
where: ai/ytdlp/ytdlp.go:31
added: 2026-11-02
---
# AI: read the video's own chapters (timecodes) as an ad signal

Authors often split a video into chapters in its description ("0:00 Вступление", "2:15 Реклама",
"14:30 Спонсор выпуска"): the title says outright that the stretch is an ad, or its name makes it
obvious (a brand, "промокод", "партнёр"). The owner calls it an important product feature
(2026-11-02). Two wins over the subtitle detector:

- **exact bounds**: the author's own timecodes, set on the video's timeline, not on the auto
  subtitle track. They need no inward rounding from cues and do not suffer from the drift that
  `timeline_unreliable` refuses (`ai-timeline-phase-3.md`), so such videos could be served too;
- **precision**: a chapter called "Реклама" is close to certain, which fits the precision-first
  rule better than a `medium`-confidence detection.

Unknowns to check first:

- whether prv exposes chapters at all: `yt-dlp -j` on a few prv videos with timecodes in the
  description: is `chapters` filled, or only `description`, from which the timecodes would be
  parsed (`m:ss Title` lines)? prv's info already lacks `view_count`, so do not assume;
- how many videos the detector takes have chapters, and how many of those name an ad
  (sample of `prv_ai_videos` published rows), so the gain is measured, not guessed.

Shape, if the data is there: `ytdlp.Info` gets `chapters` / `description` (eval repo first, then
`scripts/sync-detector.sh`: `ai/ytdlp` is a synced copy); the chapter list goes to the model next
to the transcript (prompt change, scored on the gold in the eval) or a chapter classified as an ad
becomes an entry by itself at the chapter's bounds (end = the next chapter's start). Open design
questions: chapter vs detector entry when both exist (whose bounds win), whether a chapter-only
entry skips the second opinion, and a chapter that covers more than the ad (the lead-in rule of
the review card applies).
