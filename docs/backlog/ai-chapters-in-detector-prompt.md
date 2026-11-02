---
worth: later
where: ai/prompts/v2.2.md
added: 2026-11-02
---
# AI: give the detector the video's chapter list (eval first)

The chapter check (`ai/pipeline/chapters.go`) only refines entries the detector and the second
opinion already found. The other path from the 2026-11-02 chapter research: put the chapter list
(title, start, end) into the detector's request next to the transcript, so the model can use
"Реклама" / "Нативная интеграция: <brand>" titles for recall and the chapter edges for bounds.

Eval-repo work: a prompt version with a chapters block, scored on the reviewed gold with the
held-out gate (`adskip`), the chapters from the cached `<native_id>.info.json` (189 of 609 videos
have them; skewed: one channel is 37 of the 54 videos with ad chapters, so score with and without
it). Then `scripts/sync-detector.sh` with the new prompt and `AI_PROMPT` / the default in
`ai/pipeline/detect.go`; the product already stores the chapters per run.

Risk: news titles about ads ("Законопроект о запрете рекламы") steering the model to `not_ad`
stretches; the score shows it.

Settles it: the held-out score of the chapters prompt against v2.2 on the same gold.
