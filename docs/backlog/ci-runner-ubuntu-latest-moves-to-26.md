---
worth: yes
where: .github/workflows/deploy.yml:20
added: 2026-10-29
---
# CI runs on ubuntu-latest, which GitHub is moving to Ubuntu 26

Both jobs (`test` at line 20, `deploy` at line 52) use `runs-on: ubuntu-latest`. Since 2026-10-19 GitHub
has been switching that label to Ubuntu 26. Run 40876933508 (2026-10-29) still went green but carries the
annotation. When the label flips, the Docker e2e (`make test-e2e`), Go and Node toolchain setup, and
buildx can break in the middle of a deploy, and a red test blocks the deploy. Fix: pin `ubuntu-24.04` on
both jobs, then move to 26 deliberately in its own run. Changing two lines is mechanical, but the change is
only checked when a deploy runs (push = prod).
