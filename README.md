# native-ad-skip-api

Crowdsourced ad/segment skipping for three video platforms (providers `prv`, `rt`, `yt`): users submit time-interval markups, a Go calculator aggregates them into consensus segments, browser extensions poll them to skip ads. For developers: [CLAUDE.md](CLAUDE.md) (architecture, commands, ops).

## Процесс перехода на AI-first разметку / AI-first rollout

A conceptual, non-technical explanation of how segments reach viewers before and after AI-first (detector, shifted subtitles, judge, assessor and frontend roles), for a frontend developer or an assessor:

- Русский: https://claude.ai/artifact/6NZNwDcYKbLV5MUgKPwc8n
- English: https://claude.ai/artifact/SQhQy8xEPoY8XaxvKL4d6o

The pages are private; ask the owner for access. Their source lives in [docs/ai-first-overview/](docs/ai-first-overview/) (`ru.html`, `en.html`, shared `style.css`); a change in the AI-first behaviour updates both files and the "updated" date in their header, then the two pages are republished from them. Decisions and trade-offs: [docs/plans/completed/20261022-ai-first-segments.md](docs/plans/completed/20261022-ai-first-segments.md), [docs/plans/completed/20261027-ai-hidden-entries.md](docs/plans/completed/20261027-ai-hidden-entries.md) (every detected segment kept, served vs hidden).
