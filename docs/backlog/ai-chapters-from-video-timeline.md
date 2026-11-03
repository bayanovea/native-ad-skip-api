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

Checked on the eval corpus (2026-11-02, the 609 cached `<native_id>.info.json` of
`~/Web/data/transcripts/prv/`, fetched 2026-10-10…24; these are videos with human markups, so
biased toward ones that have ads):

- **prv exposes chapters**: yt-dlp fills `chapters` (`start_time`, `end_time`, `title`) on 189
  videos (31 %), exactly those whose `description` has timecode lines, so no parsing is needed;
- **ad chapters**: a keyword match on the title (реклама, интеграция, спонсор, партнёр,
  промокод, скидка, …) finds 85 chapters; after dropping the obvious false hits by hand, 79 on 54
  videos (9 %), mean 87 s, none under 5 s. Skewed: 37 of the 54 videos are one channel that titles
  every ad "Нативная интеграция: <brand>"; the rest spread over ~12 channels;
- **bounds against the gold** (`labels`, sponsor / self_promotion): 55 of the 79 overlap a human
  label, 53 of them at IoU ≥ 0.8 (mean best IoU 0.94), so where both exist the chapter is the
  human's interval; of the 24 with no label, most are real ads nobody marked ("Рекламная пауза",
  "Нативная интеграция: …", a title with `erid`), i.e. recall the corpus lacks;
- **a keyword match is not enough**: the false hits are news titles about ads ("Законопроект о
  запрете рекламы", "Стратегический партнёр России", "спонсоров войны"), so the title needs the
  model (or the transcript under it), not a regexp.

Still open: the share on what the detector actually takes (prod `prv_ai_videos`, community
videos over the thresholds): the eval corpus over-represents the one channel and videos with
ads. Fetch the info of ~100 recent published rows (the yt-dlp info call the tick already makes;
its raw JSON is not stored today, `prv_ai_runs` keeps only the transcript) and count again.

Shape, if the data is there: `ytdlp.Info` gets `chapters` / `description` (eval repo first, then
`scripts/sync-detector.sh`: `ai/ytdlp` is a synced copy); the chapter list goes to the model next
to the transcript (prompt change, scored on the gold in the eval) or a chapter classified as an ad
becomes an entry by itself at the chapter's bounds (end = the next chapter's start). Open design
questions: chapter vs detector entry when both exist (whose bounds win), whether a chapter-only
entry skips the second opinion, and a chapter that covers more than the ad (the lead-in rule of
the review card applies).
