---
worth: yes
where: .github/workflows/deploy.yml (Deploy to Timeweb step)
added: 2026-10-16
---
# deploy builds the image on prod and has no rollback

The image is still built on the prod VM from the tarball. A bad build no longer takes the API down (no `down` since 2026-10-16), but a bad image that builds fine has no previous image to go back to. Build in CI, push to GHCR tagged by SHA, and deploy with `pull && up -d`; rollback is `up -d` with the previous tag. That also ends the other tarball quirk: it is extracted over the previous one in `/home/skipper-admin/tmp`, so files deleted from the repo stay there and `COPY . .` puts them in the image.

Already fixed on 2026-10-16: test job the deploy `needs:`, no `docker compose down`, pinned host key, `tar` excludes `.git` / `node_modules`. Since 2026-10-17 the secrets reach the remote shell over stdin (`printf %q` exports piped into `ssh … 'bash -s'`), no longer on its command line.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
