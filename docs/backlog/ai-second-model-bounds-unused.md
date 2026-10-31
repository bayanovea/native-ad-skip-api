---
worth: later
where: ai/pipeline/confirm.go (agree), ai/judge/llm.go, prv_ai_confirmations.raw_output
added: 2026-10-31
---
# The second model's bounds are used only for the veto

The second opinion (`gpt-6-luna`) only decides whether a Claude segment is served: the served bounds are Claude's, and after publish nothing reads what the second model marked except the `D` item's verdict. Its answer is kept (`prv_ai_confirmations.raw_output`, cue indices; resolve them against the run's transcript, `prv_ai_runs.transcript`), so either option below needs no new call:

1. **Use it on bad signals.** When dislikes, undos or a conflicting user markup arrive on an entry, give the judge the second model's segment next to Claude's (`ai/judge/llm.go` input), or let rules prefer whichever of the two matches the users' markup. Cheap, no change to what is served until there is evidence.
2. **Serve the average of the two models' bounds** for confirmed entries. Only once the second model is trusted: luna is a budget model, and averaging in a strange edge makes a good segment worse.

Unknown that settles it: whether the two models' edges differ in a way viewers notice. Measure on the gold first: per confirmed segment, the start / end error of Claude, of luna and of their average against the reviewed gold (an `adskip agree -bounds` mode in the eval repo), and how often the judge's cases are boundary complaints. Related: `ai-second-only-segments.md` (segments only luna found), `ai-second-model-revisit.md`.
