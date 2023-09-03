FROM node:20-alpine

WORKDIR /app

# GoLang download
ENV GOPATH /go
ENV PATH $GOPATH/bin:/usr/local/go/bin:$PATH
RUN apk add --no-cache git go && \
    mkdir -p "$GOPATH/src" "$GOPATH/bin" && chmod -R 777 "$GOPATH"

# JS install
COPY package*.json ./
RUN yarn install

COPY . .

# GoLang build
RUN go build -o commands/calculate commands/calculate.go

EXPOSE 3000

CMD ["yarn", "start"]
