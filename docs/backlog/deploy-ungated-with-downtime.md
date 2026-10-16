---
worth: yes
where: .github/workflows/deploy.yml (Deploy to Timeweb step)
added: 2026-10-16
---
# deploy puts secrets on the remote command line and has no rollback

The deploy step interpolates `DB_PASSWORD`, `AUTH_TOKEN`, `GF_ADMIN_PASSWORD` etc. into the `ssh "… export X='$X' …"` string, so they sit in the remote shell's command line (visible in `ps` on the host while it runs) and a value with a `'` breaks the script. Pass them another way (`ssh … 'bash -s' <<EOF`, `SendEnv`/`AcceptEnv`, or an env file written with `umask 077`).

The image is still built on the prod VM from the tarball. A bad build no longer takes the API down (no `down` since 2026-10-16), but a bad image that builds fine has no previous image to go back to. Build in CI, push to GHCR tagged by SHA, and deploy with `pull && up -d`; rollback is `up -d` with the previous tag. That also ends the other tarball quirk: it is extracted over the previous one in `/home/skipper-admin/tmp`, so files deleted from the repo stay there and `COPY . .` puts them in the image.

Already fixed on 2026-10-16: test job the deploy `needs:`, no `docker compose down`, pinned host key, `tar` excludes `.git` / `node_modules`.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
