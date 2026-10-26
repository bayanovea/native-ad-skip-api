---
worth: yes
where: prv/routes/videos.js (views_text param)
added: 2026-10-22
---
# no released client sends `views_text` yet, so every AI queue row is a fallback row

`GET /video-calculated` accepts `views_text` (the page's counter as text; the numeric `views` was dropped on 2026-10-26 because the string's format follows the user's locale and changes more often than the DOM, so the parsing lives here, `lib/parse-views-text.js`) and keeps the max count in `prv_ai_videos.views_max`, but no released client sends it yet: the v2 extension (`~/Web/native-ad-skip-v2`, branch `feat/views-param`) is being changed to send it together with `v`, which it never sent on this endpoint, so its users were legacy requests for the AI queue. Until they do, a video is queued only by the fallback (`requests ≥ AI_FALLBACK_REQUESTS`, then yt-dlp's `view_count` checked against `AI_MIN_VIEWS` at fetch time), which costs one yt-dlp info call per candidate and queues on our own traffic rather than the video's popularity. Old extension versions will never send it, so the fallback stays for them.

**Blocker found 2026-10-24 (first prod tick):** yt-dlp's prv extractor returns `view_count: null` (`like_count`, `comment_count` are filled), so every fallback row is stored with `views_max = 0`, goes back to `seen` and never reaches the model. Owner's choice the same day: without a `view_count` the fallback gate is our own `requests` alone (`AI_FALLBACK_REQUESTS` raised to 5); the rows the first ticks stored as 0 were reset with `UPDATE prv_ai_videos SET views_max = NULL WHERE views_max = 0 AND status = 'seen'`. Views from clients would still pick truly popular videos instead.

To do once the extension release is out: watch `prv_ai_videos` rows with a `views_text` and no `views_max` (an unreadable format, e.g. another locale) and extend the parser; close this item when the fallback rows stop being the majority of new ones. Later client signals (seeks, timeline clicks) go the same way: new event types in `POST /events`, new counters in `ai/judge/signals.go`.

From `docs/plans/completed/20261022-ai-first-segments.md` (Trigger and views, Post-Completion → External system updates).
