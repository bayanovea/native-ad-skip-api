---
worth: yes
where: CLAUDE.md (Deployment → Rollback), docker-compose.yml:21
added: 2026-11-04
---
# By-hand rollback `docker compose up` starts the app without its env

CLAUDE.md → Deployment → Rollback gives `IMAGE_TAG=<sha> docker compose -p <project> -f
/home/skipper-admin/tmp/src/docker-compose.yml up -d --no-build app` for a rollback on the host.
The `app` service takes `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `AUTH_TOKEN`, `LEGACY_PRV`, the
`AI_*` switches and keys from the invoking shell (`${…}` interpolation), and the host has no
`.env` (the deploy passes them as `printf %q` exports to its own `bash -s`). A root shell on the
host has none of them, so compose recreates the container with empty values (warnings only): no
DB settings, no `LEGACY_PRV`, every AI switch off. Not tried on prod; read from the compose file
and the deploy script.

It matters most for a pre-transfer sha (CLAUDE.md → Repo transfer), where the by-hand path is
the only one (the workflow cannot pull `ghcr.io/odedohbest/…`), and so for the rollback across
the 2026-10-29 rename. Options: give the command the stopped
container's env (`docker inspect -f '{{range .Config.Env}}…'`, as the rename-to-legacy line next
to it does, then `docker run` with the old image and the same network, ports and
`extra_hosts`), or have the deploy write a root-only env file next to the compose file that a
by-hand `docker compose --env-file` can read.
