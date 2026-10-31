---
worth: later
where: ai/pipeline/publish.go (accepted, entries), ai/pipeline/regate.go, alerting rules
added: 2026-10-30
---
# Rules the second opinion could enable

- **Lower the self_promotion threshold on agreement.** `self_promotion` at `medium` stays hidden today (owner, 2026-10-27). With two models agreeing on it, `medium` might be safe to serve; decide on the `adskip agree` numbers and `D` verdicts, then a rule change plus `ai regate` (which would need the confirmation flags per entry: today only the run's counts are stored).
- **Alert on second-opinion failures.** A failed second call degrades silently to one model (by design, owner 2026-10-30). The dashboard shows it; an alert (e.g. failures > half of the calls over 6 h) would catch an exhausted OpenAI budget the same day. Needs a Prometheus gauge or a Postgres-datasource rule like `StaleMarkups`.
- **Backfill.** `ai regate --backfill` rebuilds an empty `hidden` without the second opinion; a row published with the switch on never has an empty `hidden` when something was unconfirmed, so this matters only if the backfill is ever run on such a row with every entry served.
