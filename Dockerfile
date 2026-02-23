# ---- Stage 1: Build ----
FROM golang:alpine AS builder

RUN apk add --no-cache gcc musl-dev make npm git \
    && npm install -g uglify-js

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY . .

# Build with CGO enabled (required by go-sqlite3) and static linking against musl
RUN CGO_ENABLED=1 make build

# ---- Stage 2: Runtime ----
FROM alpine:latest

RUN apk add --no-cache ca-certificates

WORKDIR /app
RUN mkdir -p /app/data

COPY --from=builder /src/nagini-web .

EXPOSE 8080

ENV NAGINI_LISTENADDRESS=0.0.0.0
ENV NAGINI_LISTENPORT=8080
ENV NAGINI_DBPATH=data/nagini.db

ENTRYPOINT ["./nagini-web"]
