FROM node:20-bookworm-slim

WORKDIR /app

# GoLang download
ENV GOPATH /go
ENV PATH $GOPATH/bin:/usr/local/go/bin:$PATH

# Dependencies
RUN apt-get update && apt-get install -y git golang cron supervisor && \
    mkdir -p "$GOPATH/src" "$GOPATH/bin" && chmod -R 777 "$GOPATH"

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

# GoLang build
RUN go build -mod=vendor -o prv/commands/calculate ./prv/commands/ && \
    go build -mod=vendor -o rt/commands/calculate ./rt/commands/ && \
    go build -mod=vendor -o yt/commands/calculate ./yt/commands/

# Cron
COPY crontab /etc/cron.d/my-crontab
RUN chmod 0644 /etc/cron.d/my-crontab \
    && crontab /etc/cron.d/my-crontab \
    && touch /var/log/cron.log \
    && touch /var/log/cron_error.log

EXPOSE 3022
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
