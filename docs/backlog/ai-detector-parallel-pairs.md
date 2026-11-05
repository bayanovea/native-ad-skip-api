---
worth: later
where: ai/pipeline/queue.go, ai/pipeline/detect.go (newDetectRun), repository variables AI_DAILY_BUDGET_VIDEOS / AI_MODEL / AI_DETECT_CLIENT
added: 2026-11-05
---
# Two detector pairs in parallel

Change `ai-detector-roles-swap` makes the pair a matter of variables: Sonnet batch → luna or terra batch → Haiku, one
at a time. Running both (Sonnet → luna on the owner's Claude budget plus terra → Haiku on the OpenAI allowance,
~430 videos a day at 2026-11 prices) needs a second budget variable, a rule for which video goes to which pair and a
second client set in `newDetectRun`; polling already resolves each batch by its run's model.

Unknown that settles it: whether terra → Haiku holds up on prod (the two-week check in `ai-second-model-revisit.md`)
and whether the queue still outgrows one pair's budget then (`ai-detect-queue-outgrows-budget.md`).
