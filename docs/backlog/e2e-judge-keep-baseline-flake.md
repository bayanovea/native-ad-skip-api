---
worth: later
where: test/e2e.js ('ai judge: a human keep is a new baseline…'), ai/judge/signals.go
added: 2026-10-24
---
# Flaky e2e: an undo right after a keep verdict is read as old

Seen once in five local `make test-e2e` runs on 2026-10-24 (the Mac under load): in `ai judge: a human keep is a new baseline: only later signals count, a re-cut never keeps them from the LLM and its withdraw`, the tick after the second `postUndo` answered `ok` by `rules` ("every entry kept on review since the last judgement") instead of the LLM `withdraw`, i.e. the undo's `createdAt` did not count as newer than the baseline (the keep verdict's `decided_at`, or the previous tick's `judged_at`). Both come from different writers (Node vs the Go tick's `NOW()`) in different containers; look at the boundary condition in `signals.New` (`>` vs `>=`, second rounding) and at the 1-s `commitSettle`. Not seen in CI yet.
