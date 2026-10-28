---
worth: yes
added: 2026-10-29
---
# Owner's merge verdict on `-1_456000905` (videos.id 104583): 20:37–21:37 as one sponsor segment

**Blocked by `ai-merge-fragmented-entries-and-admin-review-link.md`** (both changes: absorb on keep, send-to-review
link). The owner checked the video on 2026-10-29 and wants the three served pieces 20:37–20:45, 20:58–21:15,
21:26–21:34 recorded as one sponsor segment 20:37–21:37 under his own name (`bayanovea`), with the fourth piece
22:24–22:58 left as is. Nothing happens by itself when the blocker lands: the merge is a verdict, so once the
link exists the owner (or Claude on his word) does it by hand and deletes this item:

1. `/admin/video/104583?verifyBearerToken=…` → "send to review" on the entry 20:58–21:15 (the one with item `S39`
   in `ai-served-2026-10-28-p2`, which is closed for `bayanovea`; a new item in `ai-admin-<date>` is needed).
2. `/admin/review` as `bayanovea` → take the batch → keep `sponsor` with bounds `20:37` – `21:37` (1237–1297).
3. Check `GET /video-calculated?video_id=-1_456000905&duration=1378&v=2.2.3`: two sponsor entries,
   1237–1297 `source: review` and 1344–1378 `source: ai`.
