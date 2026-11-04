---
worth: yes
where: prv/routes/videos.js (views_text param), lib/parse-views-text.js, ai/pipeline/queue.go (the score's freshness term)
added: 2026-11-04
---
# `published_text` from clients: the real publication date for the detect queue's freshness

The detect queue's score (`openspec/changes/ai-detect-queue-priority`, 2026-11-04) divides a video's value by
`1 + days since first_seen_at`. `first_seen_at` is the time the video was first requested from us, a proxy for its
publication: an old video first opened by an extension user yesterday scores as fresh and may take a slot from a
genuinely new one. Neither the stored yt-dlp info nor the extension carries the date today.

The fix follows `views_text` (`docs/backlog/ai-views-from-clients.md`):
- the extension sends the page's publication date text next to `views_text` with the segments request
  (`published_text`, as the page shows it: the format follows the user's locale, so the parsing lives here);
- `GET /video-calculated` keeps it in `prv_ai_videos` as a `published_text` / `published_at` pair, parsed by a twin of
  `lib/parse-views-text.js` (relative forms such as "yesterday" / "3 days ago" resolved against the request time; an
  unreadable text keeps the raw string and a NULL date, like `views_text` without `views_max`);
- the score's freshness term uses `published_at` when present and `first_seen_at` otherwise, so old clients and
  unparsed dates keep today's behaviour.

The 14-day expiry stays on `first_seen_at`: it bounds how long a video waits for us, not how old it is.

Needs an extension release first (the `views_text` one was out 2026-10-28, four days after the backend). Close when
the share of eligible rows with a `published_at` is most of the queue; the rows with a `published_text` and no
`published_at` are the parser's watch list, as for `views_text`.
