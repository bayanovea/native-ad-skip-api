---
worth: yes
where: docker-compose.yml:2
added: 2026-10-16
---
# container logs have no rotation limit

No service in `docker-compose.yml` sets `logging:` options, so Docker's json-file driver grows without limit on the Timeweb VM's disk, the same disk Postgres lives on. Not checked: whether the host's `/etc/docker/daemon.json` sets a default (if it does, this item is a `no`).

Fix: `logging: { driver: json-file, options: { max-size: 10m, max-file: "5" } }` on app/prometheus/grafana (a YAML anchor keeps it to one block).

From the 2026-09-24 code review (artifact "native-ad-skip-api Review"), checked against the code and the 2026-10-15 prod dump on 2026-10-16.
