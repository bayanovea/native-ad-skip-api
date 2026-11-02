---
worth: yes
where: ai/audit/rules.go, ai/audit/llm.go, ai/prompts/audit-v1.md, prv/repository/review.js (ownerAudits)
added: 2026-11-02
---
# Audit: only strict signals reach the owner, soft findings are pooled and escalated as patterns

Owner, 2026-11-02, after the first prod tick (13 batches, 33 owner/backlog findings): what the block shows is too detailed and mostly doubts about single verdicts. The owner wants to see only strict signals that something is going wrong; the rest is collected, grouped by type, and brought to the owner only once a problem repeats. Builds on the archived `review-batch-audit` (`e0272b0`). Explored and decided 2026-11-02 (calibrated on the 15 prod audit rows, `~/audit-calib.sh`); next: `/opsx:propose review-audit-strict-signals`.

## Decided

**Owner block** = strict signals + one "export to the eval: sheet X" line per sheet (replaces the per-batch `eval_ready`; hide = exported) + pattern cards. Single doubts never reach it. Telegram stays off (`telegram-blocked-from-prod-host.md`); once on, it carries only strict signals and new pattern cards.

**Strict signals** (fixed rules with numbers, never a model opinion):
- flow checks, kept as invariants though all read 0 on prod: an `ai` item with no AI row, no run transcript or empty cues; a link that is not http(s); an `ai` item starting after the longest known duration (sheet items: 31 of 659 do, a known property of the eval corpus, the page already warns, so not a signal); a latest verdict that landed nowhere (keep: no `data` / `hidden` entry at the effective bounds **and** no served entry of the same category covering them, which is the absorb case, 1 item on prod; `not_ad` / `unclear`: no `hidden` entry with reason `review` at the bounds); a judge / review-withdrawn row whose served entries are all kept after `withdrawn_at` and still withdrawn; `llm_error` on two consecutive audits of a batch;
- `rubber_stamp` per **reviewer**, not per batch: Gam's median gap is 12–14 s on most batches, so per batch it repeats daily; one card per reviewer, back only when their pace or keep share changes;
- uniform batch (≥ 10 items, ≥ 90 % `not_ad` or `unclear`) and pace < 5 s: never fired (max 11/28 `not_ad`, min median 12.7 s), kept as cheap catastrophe checks.

**Dropped:** every cross-assessor check (agreement < 60 %, keep share vs other reviewers, same-comment ×5): one assessor does all the work, `reviews_needed` is 1 on all 36 batches, only 28 stretches have two reviewers (Gam vs owner, 75 %), and the audited batches carry 0 comments. Also dropped: the separate `ai audit digest` command and the model call merging `other` names.

**Per-batch model call stays**, as the source of pooled doubts: no severity, a `topic` per finding from a fixed list (from the 20 prod findings: dubbing credits, platform's own promo, raffle / partner, lead-in and return boundary, sponsor vs self_promotion, timing / bounds, subtitle drift, page / link, judge re-cut, `other` with a short name). The prompt gets the rules the assessors see, from the same `prv/locales/review` strings, not a paraphrase: 2 of the 4 recurring prod "patterns" were doubts the rules already answer ("write in the comments" is `self_promotion` by `onb_verdicts_html`; a keep with no payer named in the text is the owner's "the video decides", `assessor-rule-text-vs-video.md`), so the prompt must not doubt a keep only because the text names no payer.

**Pool:** each audit tick, after its row, recounts the soft findings of the last 30 days by topic in one SQL over `findings` (rule kinds `judge_false_alarm`, `track_mismatch` count as their own topic; `bounds`, `precision` info and `category_flip` appear in nearly every batch and stay metrics, never cards). A topic with ≥ 5 items in ≥ 3 batches becomes one pattern card: counts, 3–5 example items with links, the suggested action. Hide stores the counts; the card comes back when the topic reaches the threshold again on new items (5 new items in 3 new batches).

**Old audits count** (owner): their findings have no topic and were made without the page rules, so after the deploy each of the 13 audited batches is re-audited once by hand (`ai audit <batch>`, ~$0.40 total) and the new rows feed the pool.
