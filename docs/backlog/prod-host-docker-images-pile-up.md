---
worth: later
where: .github/workflows/deploy.yml:197
added: 2026-10-28
---
# old app images and build cache pile up on the prod host

Nothing on the host removes Docker data. On 2026-10-28: 28 `ghcr.io/odedohbest/native-ad-skip-api:<sha>` images
(one per deploy since CI builds), the pre-GHCR local `native-ad-skip-api-app` and a `golang` image, 9.5 GB of
images in all (only 0.7 GB reclaimable by Docker's count: the sha images share most layers), the 4.6 GB build cache
from the pre-CI host builds was pruned on 2026-10-28 (13 → 9.2 GB used of 48 GB).

Fix: a one-off `docker rmi` of the local-build leftovers, and after a
successful `up -d` in the deploy script keep the last N ghcr sha images (e.g. 5) and remove the rest.
Keep N: the by-hand rollback (`IMAGE_TAG=<sha> … up -d --no-build app`) works only for images still in the
local cache; an older sha needs the workflow rollback, which pulls from GHCR.

Unknown that settles it: how fast the images actually grow per deploy (shared layers make the 9.5 GB
misleading; measure `df` before/after a few deploys). At the current rate the disk lasts long, so this
may only be the one-off cleanup.
