---
worth: now
where: repository variables AI_SECOND_CLIENT / AI_SECOND_MODEL, secret OPENAI_API_KEY, grafana/provisioning/alerting/rules.yml (AiCostDaily), ~/Web/native-ad-skip-eval (adskip detect -transport openai, adskip agree)
added: 2026-10-30
---
# Second opinion: measure and pick the model before the switch goes on

The code is in (`ai/pipeline/confirm.go`, switch `AI_SECOND_CLIENT`, off). Before `AI_SECOND_CLIENT=openai`:

1. **Model.** `gpt-6-luna`, the code default (owner, 2026-10-30): $0.10 / $0.50 per Mtok, ~$0.006 per video at ~50k input tokens, ~$36/month at 200 videos/day, well inside the $100 budget. `gpt-5` would be $430–540/month. Revisiting the choice: `ai-second-model-revisit.md`.
2. **Eval run** (needs an OpenAI key in the eval shell): `adskip detect -set <held-out set> -transport openai -model gpt-6-luna -effort medium -no-times`, then `adskip agree <the v2.2 batch run> <that run>`. Read TP vetoed (recall cost) against FP vetoed (wrong cuts saved) at IoU 0.3 (the product threshold since 2026-10-31), and the cost per video from the run's metrics. Reference: Claude against itself (batch vs cli runs of 2026-10-23) vetoes 16 of 250 true ads and 14 of 61 wrong cuts at 0.5.
3. **Set** the OpenAI project's monthly hard spend limit to $100 (Project settings → Limits → Spend → Enforce a hard limit; a hit is a 429 `project_spend_limit_exceeded`, which the product treats as a failed second call), then `OPENAI_API_KEY` secret, `AI_SECOND_CLIENT=openai` variable, deploy with `image_tag` = the running sha.
4. **Day after**: the dashboard row "4б. Второе мнение" (calls, confirmed share, failures, cost), open `D` items on `/admin/review`.
