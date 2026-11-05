---
worth: later
where: ai/pipeline/detect.go:677
added: 2026-11-05
---
# Second opinion on Sonnet through the Batches API, terra's segments served meanwhile

Owner's idea (2026-11-05): once terra detects and Haiku 5.5 confirms (change `ai-detector-roles-swap`), move the second
opinion to Sonnet 5.5 through the Anthropic Batches API, accumulating several videos per batch, and serve terra's
segments to viewers while Sonnet's batch is still running.

How it works today: only the detector goes through a batch (up to `AI_BATCH_MAX` videos per tick, polled on later
ticks). The second opinion is a synchronous call per video inside `poll()`, right before `finish()` publishes, so a
video has no AI row, and viewers get the human segments, until both models have answered.

`adskip agree` on the held-out set (216–217 videos, reviewed gold, IoU 0.3), served after the veto:

| second opinion | true ads served | wrong cuts served | unconfirmed (`D` items) per video | cost per video |
|---|---|---|---|---|
| Haiku 5.5, Messages | 250 / 321 | 39 / 126 | 0.73 | $0.0023 |
| Sonnet 5.5, Batches | 293 / 324 | 37 / 127 | 0.56 | ≈ $0.032 (32k-token transcript, batch −50 %) |

Sonnet serves 43 more true ads at the same number of wrong cuts. The reviewed gold was built from Sonnet's own
stretches, which flatters Sonnet's agreement with it.

What has to be settled before this is a `yes`:

- **Cost.** Sonnet brings the Claude bill back as the throughput limit the swap removed: ≈ $7.4/day at 230 videos,
  ≈ $64/day at 2 000.
- **Serving terra unconfirmed.** This goes against the precision-first rule: terra alone served 321 true ads against
  126 wrong cuts (72 %), versus 89 % after Sonnet. Viewers would see that for the whole Sonnet batch, minutes as a
  rule and up to 24 h. The variant that keeps the rule is a batch second opinion before publish: the AI row only
  appears later and the human segments are served until then, as during the detector's batch today.
- **Effort if terra is served first:** a new run state between detect and confirm, a second batch to poll, publish
  twice (the second publish moves the unconfirmed entries to `hidden` with reason `unconfirmed`), votes cast on an
  entry that is hidden afterwards, and `D` items created at the second publish. The variant without serving first
  only needs the second batch and its state.

Decide after two weeks of terra → Haiku on prod (`ai-second-model-revisit.md`: the `D` verdicts show how many true ads
Haiku vetoes), and with the throughput the OpenAI allowance actually buys by then.
