---
worth: later
where: prv/routes/provider-router.js:7, prv/routes/videos.js, prv/routes/votes.js, lib/find-ai-calculated.js, prv/routes/markups.js (ban gate)
added: 2026-11-06
---
# rt/yt run without AI and without the ban gate

Since the shared routes, rt and yt mount the prv modules, but everything prv-only is switched off by what rt/yt lack: no `AiVideoCalculated` model (no AI lock on votes, no AI-first lookup, no AI queue from `views_text`), no moderation repository (no ban gate on markups, no auto-ban). rt/yt clients get only human markups, and a spammer on rt/yt cannot be banned.

When rt/yt have real traffic: decide per provider whether to add the AI tables and the `ai` pipeline (detector input differs per platform — yt-dlp support, chapters, geo), and give rt/yt `banned_at` plus the moderation repository so the ban gate and auto-ban apply. Both are schema plus wiring through `createProviderRouter`'s extra deps; the route code already handles them.
