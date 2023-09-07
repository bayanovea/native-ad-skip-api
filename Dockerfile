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
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# GoLang build
RUN go build -o commands/calculate commands/calculate.go

# Cron
COPY crontab /etc/cron.d/my-crontab
RUN chmod 0644 /etc/cron.d/my-crontab \
    && crontab /etc/cron.d/my-crontab \
    && touch /var/log/cron.log

EXPOSE 3000
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
