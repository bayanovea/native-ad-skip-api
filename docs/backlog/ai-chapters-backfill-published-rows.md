---
worth: later
added: 2026-11-02
---
# AI: the chapter check on rows published before it

The chapter check (`ai-chapters-from-video-timeline.md`: a served entry takes the chapter's bounds
when both edges are near, else a review item offers them) runs on new publications only, as the
second opinion does (owner, 2026-11-02). Rows published before it keep their cue bounds.

A one-off over them means a yt-dlp `info` fetch per row from the prod host (~1000+ videos on
2026-10-28, hours at `AI_FETCH_PAUSE`, the same ban risk as the tick's fetches) and, at the 3 % of
the 2026-11-02 sample, ~30 review items at once.

Settles it: whether the chapter bounds visibly help on new publications (owner's check in the
player, verdicts on the chapter review items) after a few weeks of the check running.
