#!/bin/sh
set -eu
cd "$(dirname "$0")"
test "$#" = 1 || { echo "usage: build.sh <output-file>" >&2; exit 2; }
: "${TARGETARCH:=amd64}"
case "$TARGETARCH" in amd64) target=x86_64-unknown-linux-musl ;; arm64) target=aarch64-unknown-linux-musl ;; *) echo "unsupported target architecture" >&2; exit 2 ;; esac
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
  cargo build --release --locked --target "$target"
cp "target/$target/release/laterdog-restore" "$1"
