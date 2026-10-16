---
worth: yes
where: prv/routes/admin.js:114
added: 2026-10-16
---
# /admin/video and /admin/video/:id/user pages interpolate values without escaping

`admin.js` builds HTML with template strings and no escaping: `videoId` (from the URL, matched against `native_id`), `prvUserId`, the token. `native_id` is any string a client sends to `POST /markup`, so a crafted video id stored that way runs script on the admin page, where `const AUTH_TOKEN = '…'` sits in the page source. `escapeHtml` already exists in `lib/admin-html.js` (used by moderation and review); admin.js imports only `CATEGORY_COLORS` from it.

Fix: `escapeHtml` on every interpolated value, `JSON.stringify` for the token inside `<script>`.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
