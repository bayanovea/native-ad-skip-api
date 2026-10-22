# GoLang build: the three calculator binaries, static (CGO off) so they run in
# the Node image without a Go toolchain
FROM golang:1.27-bookworm AS go-build

WORKDIR /src

COPY go.mod go.sum ./
COPY vendor/ vendor/
COPY calculator/ calculator/
COPY prv/commands/ prv/commands/
COPY rt/commands/ rt/commands/
COPY yt/commands/ yt/commands/
COPY ai/ ai/

RUN CGO_ENABLED=0 go build -mod=vendor -o prv/commands/calculate ./prv/commands/ && \
    CGO_ENABLED=0 go build -mod=vendor -o rt/commands/calculate ./rt/commands/ && \
    CGO_ENABLED=0 go build -mod=vendor -o yt/commands/calculate ./yt/commands/

# yt-dlp: the standalone release build (bundles its own Python), pinned and checksummed
FROM golang:1.27-bookworm AS ytdlp
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) f=yt-dlp_linux; sum=d8bd33fca9d5b23bd5b9952b3fca36db5c46331933fda9f598a3da14ce2c243f ;; \
      arm64) f=yt-dlp_linux_aarch64; sum=e137c2171b0b8ef648e6136e86aa70c65923e93e434f01c93901d64744b190aa ;; \
      *) echo "no yt-dlp build for '$TARGETARCH'" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/$f" && \
    echo "$sum  /yt-dlp" | sha256sum -c - && \
    chmod 0755 /yt-dlp

FROM node:20-bookworm-slim

WORKDIR /app

# Dependencies. EXTRA_PACKAGES is empty for the prod image; docker-compose.e2e.yml
# sets it to postgresql-client so the e2e suite can run scripts/*.sh through psql.
ARG EXTRA_PACKAGES=""
RUN apt-get update && apt-get install -y cron supervisor $EXTRA_PACKAGES

COPY --from=ytdlp /yt-dlp /usr/local/bin/yt-dlp

# JS install
COPY package*.json ./
RUN yarn install

COPY . .

# init scripts
RUN chmod +x infrastructure/init/init_env.sh
RUN chmod +x infrastructure/init/run_yarn.sh

# supervisor
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
RUN touch /tmp/supervisor.sock && chmod 700 /tmp/supervisor.sock

# GoLang binaries, after `COPY . .` so a stale binary in the build context never overwrites them
COPY --from=go-build /src/prv/commands/calculate prv/commands/calculate
COPY --from=go-build /src/rt/commands/calculate rt/commands/calculate
COPY --from=go-build /src/yt/commands/calculate yt/commands/calculate

# Cron
COPY crontab /etc/cron.d/my-crontab
RUN chmod 0644 /etc/cron.d/my-crontab \
    && crontab /etc/cron.d/my-crontab \
    && touch /var/log/cron.log \
    && touch /var/log/cron_error.log

EXPOSE 3022
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
