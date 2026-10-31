---
worth: later
where: ai/pipeline/confirm.go, ai/pipeline/regate.go (the shape of a one-off pass over every AI row)
added: 2026-11-01
---
# AI rows published before the second opinion were never checked by it

The second opinion runs only at publish, so every `prv_ai_video_calculateds` row published before `AI_SECOND_ENABLED=on` serves Claude's segments alone, unconfirmed, for as long as the row lives. Nothing re-checks them; the judge sees them only once viewers send bad signals.

A one-off command (`ai confirm [--dry-run]`, shaped like `ai regate`) could run the second model over the rows that have no `prv_ai_confirmations` row for their `run_id`:

- the request is rebuilt from the stored run (`prv_ai_runs.transcript`, the current prompt; the confirmation row records its sha), one synchronous call per row, outside any lock;
- the gate applies only to served entries the model published as is (`source: "ai"`) whose latest ai-item verdict is not a keep: an assessor's word beats both models, and an entry moved by review has no counterpart in either answer;
- an unconfirmed entry moves to `hidden` as `unconfirmed` with a `D` item, under the `video_calculateds` lock then the AI row's (the vote handlers' order), its rating dropped as any entry leaving `data`; a row left with empty `data` serves nothing (as `ai regate`, no withdraw);
- a failed call changes nothing and the row is retried on the next run.

Cost and load: ~$0.006 per row on `gpt-6-luna`; on the held-out set 31 of 311 served segments went unconfirmed at IoU 0.3, so roughly one `D` item per seven segments, all at once unless the pass is spread over days.

Unknown that settles it: whether the old rows' wrong cuts are worth the review burst. The judge already acts on bad signals for served rows; look at how many old served rows drew judge `review` / `withdraw` and what share of their items assessors marked `not_ad` before building this. Related: `ai-second-opinion-switch-on.md`.
