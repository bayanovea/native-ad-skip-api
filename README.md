# native-ad-skip-api

The backend of a browser extension that skips native ads in videos on a large video platform
(~11k weekly users). Viewers mark the ad segments in a video, the service merges their marks into
consensus segments, and every other viewer's extension skips them. The newer half is AI-first: an
LLM detector finds the segments from the platform's auto-generated subtitles, so a video can be
covered before any human has marked it.

The detector's quality is measured in a separate public repo,
[native-ad-skip-eval](https://github.com/bayanovea/native-ad-skip-eval): the eval harness, the
prompt history and the numbers. This repo is the production side: how the detector's output reaches
viewers safely.

## How it works

- **Crowd path.** A Node.js API takes time-interval markups (sponsor, self-promotion, intro,
  credits) from the extension. A Go calculator aggregates them into consensus segments, and viewers'
  votes rate each segment; clients poll the result. The same API serves three platforms, `prv`, `rt` and `yt`
  (`prv` is the main one), each with its own tables.
- **AI-first path** (`prv` only, every switch off by default). A Go command picks videos by views
  and requests, fetches the auto subtitles, and asks Claude for segments through the Batches API
  under a daily budget. Segments are served only for the cut of the video the detector saw. A
  judge reads new user signals on served segments (down-votes, undos, conflicting human markups)
  and withdraws a video's segments or sends them to human review. `AI_FIRST=off` is the kill switch: viewers get the human
  segments again and no data is touched.
- **Assessor tools.** Review pages and exports where paid assessors check segments; their verdicts
  feed the eval sets.

## Where to read

- [CLAUDE.md](CLAUDE.md): architecture, commands, environment, operations. It is the developer
  guide, and the agent's instructions for this repo.
- [docs/plans/completed/](docs/plans/completed/): decisions and trade-offs, one plan per change.
  The AI-first design is in
  [20261022-ai-first-segments.md](docs/plans/completed/20261022-ai-first-segments.md) and
  [20261027-ai-hidden-entries.md](docs/plans/completed/20261027-ai-hidden-entries.md).
- [docs/ai-first-overview/](docs/ai-first-overview/): a non-technical explanation of the AI-first
  rollout for frontend developers and assessors (`en.html`, `ru.html`).
