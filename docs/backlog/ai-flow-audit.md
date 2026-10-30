---
worth: yes
added: 2026-10-30
---
# Audit the AI-first flow end to end, and the docs that describe it

The flow has grown one piece at a time (detect, gates, `hidden`, verdicts with bounds, absorb, judge, below-threshold / adopt / admin items, regate, now the second opinion), each with its own plan or OpenSpec change. Nobody has walked it whole since. Owner (2026-10-30): check that it works as intended, that we still understand it, and that the docs say what the code does.

**Do it after** the second-opinion change (`openspec/changes/ai-second-detector-openai/`) is committed, so the audit reads one state; its open tasks (eval 1.3–1.5, overview 7.2) are that change's, not this item's.

**1. The flow.** One table: every state an entry or a row can be in (`data` / `hidden` × reason `confidence` | `short` | `review` | `unconfirmed`; row published / withdrawn by `judge` | `review` | `admin`; `prv_ai_videos.status`) against every writer (publish + `confirm.go`, `applyVerdict`, `ai regate [--backfill]`, judge, withdraw / restore, `sendToReview`, the import / adopt scripts, the vote handlers). For each cell: what moves, under which lock order, and whether a test covers it. Look for:
- transitions no writer makes, or two writers make differently (e.g. `unconfirmed` across regate, `--backfill`, a keep, a `not_ad` on a `D` item; an absorb over an unconfirmed or hidden entry);
- the four item producers (`A` judge, `B` below-threshold, `M` admin, `D` second opinion) and the dedupe rules between them (`openAiItems`, `hasItemAt`): can one entry get two open items;
- what the judge sees and does not (empty `data`, `unconfirmed` entries, `(bounds by review)`);
- lock orders across Go and JS (`video_calculateds` → AI row → batch row, and batch row → AI row in decide) still acyclic with `confirm.go` writing review items in the publish transaction.

**2. The docs.** Cross-check against the code, fix the drift in the same change:
- `CLAUDE.md` → AI-first segments, Ops (`regate`, imports), Database Models, Metrics, Alerting (`AiCostDaily` vs `kind="confirm"`);
- `docs/ai-first-overview/{ru,en}.html`: neither mentions the second opinion today (0 hits for `unconfirmed`);
- `openspec/specs/` holds only three capabilities (`ai-detect-queue`, `ai-verdict-application`, `admin-ai-review-request`); the publish gates, `hidden`, the judge and the second opinion live only in CLAUDE.md and completed plans. Decide whether to write specs for them or say plainly that CLAUDE.md is the source of truth;
- the dashboard (`grafana/dashboards/ai-pipeline.json`): every hidden reason, the funnel stage of a row whose only served entries went `unconfirmed` (stage 9), the misses pair;
- `docs/backlog/ai-*.md`: items the audit closes or makes stale.

Deliverable: the state × writer table (a completed plan or a `docs/` page), the fixes or new backlog items for what it finds, the docs brought in line.
