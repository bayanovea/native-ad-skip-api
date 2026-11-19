---
worth: later
where: ai/budget/budget.go (Save), ai/pipeline/queue.go (queueRule thresholds), prv_ai_budgets, grafana/dashboards/ai-pipeline.json (the /* AI_MIN_VIEWS */ and /* AI_MIN_REQUESTS */ literals)
added: 2026-11-19
---
# The spend budget lowers and raises the detector's thresholds itself

The spend budget (`AI_BUDGET_ENABLED`, change `ai-model-budget-controller`) only paces: when OpenAI's allowance is more
than the videos past `AI_MIN_VIEWS` / `AI_MIN_REQUESTS` can use, the money expires unspent. Until this item, the owner
steps the thresholds by hand by the rule in `docs/reference/ops.md` → Spend budget (owner, 2026-11-19: the controller
does it in the end): OpenAI's forecast unspent over 20 % of its usable amount three days running and the queue under a
day's claims → `AI_MIN_VIEWS` one step down (500000 → 300000 → 200000 → 100000); the cap spent before 18:00 UTC three
days running → one step up. Each step is a commit of the dashboard literals, a repository variable and a deploy.

The controller would apply the same rule on the detect tick from its own state history and store the thresholds in
effect with the budget state (columns on `prv_ai_budgets` or a row of their own), so `claimQueued` reads them there
instead of the env (which stays the floor / start value) and the dashboard's SQL joins the stored values: the
`/* AI_MIN_VIEWS */` and `/* AI_MIN_REQUESTS */` literals go, and a step needs no commit or deploy.

Settles it: a few manual steps by the rule showing the rule is right (no oscillation between steps, the queue and the
`D` cap holding at the lower thresholds). Open: whether the forecast should first raise the detector's model tier
instead of lowering thresholds (the eval track's answer).
