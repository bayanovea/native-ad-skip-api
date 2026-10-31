---
worth: later
where: ai/pipeline/confirm.go (agree, record), prv_ai_confirmations.raw_output
added: 2026-10-30
---
# Segments only the second model found

The second opinion only vetoes: a segment the second model found and the detector did not is counted (`prv_ai_confirmations.extra`) and kept in `raw_output`, never an entry or a review item. It is the recall the detector misses. Once the dashboard shows how many there are and the first `D` verdicts show the second model's precision, they could become hidden entries (reason e.g. `second_only`) with their own review items, so a keep serves them. Why later: every one is assessor load, and the second model's precision is unknown until its first verdicts.
