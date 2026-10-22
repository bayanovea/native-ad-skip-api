# native-ad-skip-api

Crowdsourced ad/segment skipping for prv, rt and yt videos: users submit time-interval markups, a Go calculator aggregates them into consensus segments, browser extensions poll them to skip ads. For developers: [CLAUDE.md](CLAUDE.md) (architecture, commands, ops).

## Процесс перехода на AI-first разметку / AI-first rollout

A conceptual, non-technical explanation of how segments reach viewers before and after AI-first (detector, shifted subtitles, judge, assessor and frontend roles), for a frontend developer or an assessor:

- Русский: [docs/ai-first-overview/ru.html](docs/ai-first-overview/ru.html)
- English: [docs/ai-first-overview/en.html](docs/ai-first-overview/en.html)

Open the file in a browser (GitHub shows the source). Both pages must say the same thing: a change in the AI-first behaviour updates both and the "updated" date in their header. Decisions and trade-offs: [docs/plans/completed/20261022-ai-first-segments.md](docs/plans/completed/20261022-ai-first-segments.md).
