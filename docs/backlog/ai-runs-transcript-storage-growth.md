---
worth: later
where: prv/repository/review.js:716
added: 2026-10-28
---
# prv_ai_runs.transcript grows the DB and the dumps ~25 MB/day

`make pull-dump` of 2026-10-28 is 92 MB gzipped against 1.3 MB on 2026-10-21; `prv_ai_runs` is 423 of ~430 MB
of the dump's COPY data (576 runs, ~0.74 MB each). In `transcript` 217 of 355 MB (chars) are the per-word
tags (`cues[].words`, stored since 2026-10-24, 420 runs have them), the rest is cue text. At ~150 runs/day
that is ~110 MB/day raw, ~25 MB/day gzipped, and it scales with `AI_DAILY_BUDGET_VIDEOS` (300 → twice that).

Who reads what: the words only the review page's transcript window (selection → bounds snapping); the judge
(`ai/judge/llm.go`), `ai regate --backfill` and `import-below-threshold.js` read cue text only.

Options: keep words only for runs whose AI row has review items, or move them to their own table / column
so dumps and backups can skip them (they can always be refetched from prv while the video is up); compact
the words' JSON (`{t, text}` per word); retention for runs whose row has no item after N days.

Prod disk (2026-10-28): 48 GB, 13 GB used, 35 GB free; the DB is 183 MB, `prv_ai_runs` 160 MB of it (TOAST
compresses to ~0.28 MB/run, ~40 MB/day at 150 runs, ~80 at the 300 budget), so the disk lasts 1–2 years:
not the constraint. Most of the 13 GB is Docker (9.5 GB images, one per deploy, 4.6 GB build cache).

Unknown that settles it: the size budget of the S3 nightly job (`offhost-pg-backup-s3.md`), and the 1-year
horizon at full budget. If S3 cost is negligible, this is a `no`.
