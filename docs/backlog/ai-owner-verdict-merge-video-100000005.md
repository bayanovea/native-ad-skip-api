---
worth: yes
added: 2026-10-29
---
# Owner's merge verdict on `-1_456000905` (videos.id 104583): 20:37–21:37 as one sponsor segment

The owner checked the video on 2026-10-29 and wants the three served pieces 20:37–20:45, 20:58–21:15,
21:26–21:34 recorded as one sponsor segment 20:37–21:37 under his own name (`bayanovea`), with the fourth piece
22:24–22:58 left as is. The tools landed with the OpenSpec change `ai-merge-fragmented-entries-and-admin-review-link`
(absorb on keep, the admin send-to-review link); nothing happens by itself: the merge is a verdict, so the owner (or
Claude on his word) does it by hand after the deploy and deletes this item:

1. `/admin/video/104583?verifyBearerToken=…` → "Send to review" in the Review column of the entry 20:58–21:15 (its
   item `S39` in `ai-served-2026-10-28-p2` is decided, so the link creates `M<n>` in `ai-admin-<date>`, priority urgent;
   a 409 means an open item already exists: decide that one instead).
2. `/admin/review` as `bayanovea` → take `ai-admin-<date>` → `sponsor` with bounds `20:37` – `21:37` (1237–1297); the
   page warns "covers 2 other served segments", the save answers `absorbed: 2`.
3. Check `GET /video-calculated?video_id=-1_456000905&duration=1378&v=2.2.3`: two sponsor entries,
   1237–1297 `source: review` and 1344–1378 `source: ai`.
