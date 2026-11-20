---
worth: yes
added: 2026-11-20
---
# AI_BUDGET_BACKLOG_USD still set after the confirmation backlog is empty

On 2026-11-20 the owner set the repository variable `AI_BUDGET_BACKLOG_USD` to 15 (07:01 UTC deploy of
`ad632f58335cc8510ea18f5420c371ca8c20a332`) to catch up the second-opinion backlog: 1,625 rows at the first
tick, ~120 an hour, expected empty around 21:00 UTC. While it stays set, every `ai detect` tick adds $15 to
Anthropic's cap for the day, so the controller never defers a second opinion on Anthropic spend: pacing for
that vendor is effectively off, and only the later days' smaller caps pay it back.

Done when the backlog count is 0 (panel 88 on `ai-pipeline`, or the rule in `ai/pipeline/backlog.go`) and the
variable is gone again, with a redeploy of the running sha (variables are read at deploy):

```
gh variable delete AI_BUDGET_BACKLOG_USD
gh workflow run deploy.yml -f image_tag=<running sha>
```

Check after the deploy: `/app/.env` has an empty `AI_BUDGET_BACKLOG_USD`, and `prv_ai_budgets.cap_today` for
anthropic is back to the plain formula on the next UTC day. The day-after reminder
(`~/.claude/reminders/adskip-budget-check.md`) prompts this too; delete this file in the commit that records it.
