---
worth: yes
where: .github/workflows/deploy.yml:47
added: 2026-11-26
---
# No fast deploy mode: every deploy waits for the full test job

Every deploy, a push to `main` or a manual dispatch (the `image_tag` rollback included), runs the whole
`test` job before `deploy` (`needs: test`). On the 2026-11-25 run that was ~4 min of ~7.5: e2e ~3 min,
Go unit ~50 s, Node unit seconds; the build ~2.5 min, the deploy step ~20 s. A change that is safe by
construction (a dashboard JSON, an alert text, a `scripts/` tool, a flag-only redeploy, a rollback to an
image that already passed) waits the same as a schema change. The owner asked for a mode that skips e2e
or all tests for such changes.

Options, cheapest first:

- **Docs-only pushes don't deploy at all**: `paths-ignore` on the push trigger for `docs/**`,
  `openspec/**`, `*.md` (not `grafana/**` or `config/**`: those are bind-mounted from the checkout and
  need the deploy). Today a backlog commit pushed to `main` is a full test + build + deploy.
- **Dispatch input** `tests: full | no-e2e | none` (default `full`), only on `workflow_dispatch`. The
  e2e step gets `if: inputs.tests != 'no-e2e'` (an unset input on push = `full`), the `test` job
  `if: inputs.tests != 'none'`; `deploy` then needs `if: ${{ !cancelled() && (needs.test.result ==
  'success' || needs.test.result == 'skipped') }}`, otherwise a skipped `test` skips it too.
- **Commit marker** (`[skip e2e]` in the head commit's message, read from
  `github.event.head_commit.message`), so the fast path is one push rather than a `[skip ci]` push plus
  a dispatch. On a push of several commits only the head commit's message counts, so the marker can
  cover a change it was not written for.

Decision left: whether the fast path is per push (marker) or per dispatch only, and whether `none`
(no Go/Node unit tests either) is offered at all: unit tests are under a minute, the gain is in e2e.
The image built without tests lands in GHCR under its sha like any other, so a rollback to it later
looks like a tested one; the run's summary should say which tests it skipped. The rollback dispatch
(`image_tag`) tests the dispatched ref's checkout, not the image it deploys, so skipping tests there
loses nothing.
