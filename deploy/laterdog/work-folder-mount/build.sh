#!/bin/sh
set -eu
cd "$(dirname "$0")"
export GOTOOLCHAIN=local GOWORK=off GOFLAGS= GOEXPERIMENT= GOAMD64=v1 GOARM64=v8.0
test "$(go env GOVERSION)" = go1.27.4 || { echo "Go 1.27.4 is required" >&2; exit 1; }
: "${TARGETARCH:=$(go env GOARCH)}"
test "$#" = 1 || { echo "usage: build.sh <output-file>" >&2; exit 2; }
case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported target architecture" >&2; exit 2 ;; esac
CGO_ENABLED=0 GOOS=linux GOARCH="$TARGETARCH" go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$1" .
