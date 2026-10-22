# ---- Stage 1: Build ----
FROM golang:1.27-alpine3.24 AS builder

RUN apk add --no-cache gcc musl-dev make npm git \
    && npm install -g uglify-js

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build with CGO enabled (required by go-sqlite3) and static linking against musl
RUN CGO_ENABLED=1 make build

# ---- Stage 2: Runtime ----
FROM alpine:3.24

RUN apk add --no-cache ca-certificates \
    && addgroup -S nagini \
    && adduser -S -G nagini -H -s /sbin/nologin nagini

WORKDIR /app
RUN mkdir -p /app/data && chown nagini:nagini /app/data

COPY --from=builder /src/nagini-web .

USER nagini

EXPOSE 8080

ENV NAGINI_LISTENADDRESS=0.0.0.0
ENV NAGINI_LISTENPORT=8080
ENV NAGINI_DBPATH=data/nagini.db

ENTRYPOINT ["./nagini-web"]
