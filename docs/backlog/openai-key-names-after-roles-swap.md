---
worth: yes
added: 2026-11-05
---
# OpenAI key names in adskip-prod and adskip-eval no longer say what the keys do

The restricted keys of both OpenAI projects were created and named for the second opinion (Chat Completions only).
With the detector roles swap (`openspec/changes/ai-detector-roles-swap/`) they also carry Files + Batch and serve the
detector, so their names in the OpenAI dashboard mislead whoever opens the project next. Rename both to their role (the
detector's model calls, not "second opinion"). A rename in the dashboard keeps the key value, so the `OPENAI_API_KEY`
secret, the Keychain copy and `~/.config/adskip/openai.key` stay as they are; if the dashboard cannot rename a key, a
new key with the same permissions replaces it in all three places. Owner's action, best done together with the
Files + Batch widening.
