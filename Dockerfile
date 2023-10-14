FROM node:20-buster

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

# env
COPY init_env.sh /usr/local/bin/init_env.sh
RUN chmod +x /usr/local/bin/init_env.sh

# supervisor
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
RUN touch /tmp/supervisor.sock && chmod 700 /tmp/supervisor.sock

# GoLang build
RUN go build -o commands/calculate commands/*.go

# Cron
COPY crontab /etc/cron.d/my-crontab
RUN chmod 0644 /etc/cron.d/my-crontab \
    && crontab /etc/cron.d/my-crontab \
    && touch /var/log/cron.log \
    && touch /var/log/cron_error.log

EXPOSE 3000
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
