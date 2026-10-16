---
worth: yes
where: .github/workflows/deploy.yml:40
added: 2026-10-16
---
# deploy runs no tests and takes the API down for the whole build

Every push to `main` deploys without `make test-unit` / `make test-e2e` / `go test`. The script runs `docker compose down`, then `up --build` on the prod VM, so the API is down for the whole image build, and a failed build leaves it down with no previous image to roll back to. Smaller: `StrictHostKeyChecking=no`; secrets are interpolated into the remote shell command line; `tar czf - .` ships `.git` and local junk.

Already fixed since the review: `restart: unless-stopped` on app, `actions/checkout@v4`.

Fix, in order of value: a test job that deploy `needs:`; drop the `down` (`up --build -d` recreates only after a successful build); pin the host key in a secret; later, build the image in CI → GHCR → `pull && up -d` for rollback.

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
