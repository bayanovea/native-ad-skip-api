FROM node:20-alpine

WORKDIR /app

# GoLang download
ENV GOPATH /go
ENV PATH $GOPATH/bin:/usr/local/go/bin:$PATH

# Dependencies
RUN apk add --no-cache git go cron && \
    mkdir -p "$GOPATH/src" "$GOPATH/bin" && chmod -R 777 "$GOPATH"

# JS install
COPY package*.json ./
RUN yarn install

COPY . .

# GoLang build
RUN go build -o commands/calculate commands/calculate.go

# Cron
COPY crontab /etc/cron.d/my-crontab
RUN chmod 0644 /etc/cron.d/my-crontab
RUN crontab /etc/cron.d/my-crontab
RUN touch /var/log/cron.log

EXPOSE 3000
CMD ["cron", "-f"]