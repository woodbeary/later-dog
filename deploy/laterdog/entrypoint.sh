#!/bin/sh
# later.dog supervisor container entrypoint.
#
# Without LATERDOG_STATE_URL this behaves exactly like `node laterdog/main.js` (Compose, the CI smoke test). With it (Cloudflare
# Containers, whose disk is wiped on every restart) the supervisor's durable state is restored from that HTTP store on boot and
# backed up whenever it changes, on a timer and on SIGTERM. The store is the Worker's `state.r2` virtual host, so the container
# never holds R2 credentials. The Codex login (auth.json) and the GitHub login (gh hosts.yml) are encrypted with LATERDOG_BACKUP_KEY
# before they leave the container.
set -u

STATE_URL="${LATERDOG_STATE_URL:-}"
DATA="${LATERDOG_DATA_DIR:-/var/lib/laterdog}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
GH_DIR="${GH_CONFIG_DIR:-$HOME/.config/gh}"
INTERVAL="${LATERDOG_BACKUP_INTERVAL_SECONDS:-60}"
mkdir -p "$DATA" "$CODEX_DIR" "$GH_DIR"

log() { echo "laterdog: $*" >&2; }

fetch_state() { # <name> <destination>; succeeds only on HTTP 200
  code=$(curl -sS -o "$2.tmp" -w '%{http_code}' "$STATE_URL/$1" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then mv "$2.tmp" "$2"; return 0; fi
  rm -f "$2.tmp"; return 1
}
put_state() { # <name> <file>
  curl -sS -f -X PUT --data-binary "@$2" "$STATE_URL/$1" >/dev/null
}
hash_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

restore() {
  [ -n "$STATE_URL" ] || return 0
  fetch_state workspace.sqlite "$DATA/workspace.sqlite" && log "restored workspace.sqlite"
  fetch_state config.json "$DATA/config.json" && log "restored config.json"
  if fetch_state artifacts.tar "$DATA/artifacts.tar"; then
    tar -xf "$DATA/artifacts.tar" -C "$DATA" && log "restored artifacts"
    rm -f "$DATA/artifacts.tar"
  fi
  if [ -n "${LATERDOG_BACKUP_KEY:-}" ] && fetch_state codex-auth.json.enc "$CODEX_DIR/auth.json.enc"; then
    if openssl enc -d -aes-256-cbc -pbkdf2 -pass env:LATERDOG_BACKUP_KEY -in "$CODEX_DIR/auth.json.enc" -out "$CODEX_DIR/auth.json" 2>/dev/null; then
      chmod 600 "$CODEX_DIR/auth.json"; log "restored Codex login"
    else
      log "could not decrypt the Codex login backup; a fresh login is required"
    fi
    rm -f "$CODEX_DIR/auth.json.enc"
  fi
  if [ -n "${LATERDOG_BACKUP_KEY:-}" ] && fetch_state gh-hosts.yml.enc "$GH_DIR/hosts.yml.enc"; then
    if openssl enc -d -aes-256-cbc -pbkdf2 -pass env:LATERDOG_BACKUP_KEY -in "$GH_DIR/hosts.yml.enc" -out "$GH_DIR/hosts.yml" 2>/dev/null; then
      chmod 600 "$GH_DIR/hosts.yml"; log "restored GitHub login"
    else
      log "could not decrypt the GitHub login backup; connect GitHub again"
    fi
    rm -f "$GH_DIR/hosts.yml.enc"
  fi
}

# Upload each piece of state only when its content hash changed since this shell last uploaded it.
backup() {
  [ -n "$STATE_URL" ] || return 0
  if [ -f "$DATA/workspace.sqlite" ] && sqlite3 "$DATA/workspace.sqlite" ".backup '$DATA/.backup.sqlite'" 2>/dev/null; then
    h=$(hash_of "$DATA/.backup.sqlite")
    if [ "$h" != "${LAST_DB:-}" ] && put_state workspace.sqlite "$DATA/.backup.sqlite"; then LAST_DB=$h; fi
  fi
  if [ -f "$DATA/config.json" ]; then
    h=$(hash_of "$DATA/config.json")
    if [ "$h" != "${LAST_CONFIG:-}" ] && put_state config.json "$DATA/config.json"; then LAST_CONFIG=$h; fi
  fi
  if [ -d "$DATA/artifacts" ]; then
    tar -cf "$DATA/.artifacts.tar" -C "$DATA" artifacts 2>/dev/null
    h=$(hash_of "$DATA/.artifacts.tar")
    if [ "$h" != "${LAST_ARTIFACTS:-}" ] && put_state artifacts.tar "$DATA/.artifacts.tar"; then LAST_ARTIFACTS=$h; fi
  fi
  if [ -n "${LATERDOG_BACKUP_KEY:-}" ] && [ -f "$CODEX_DIR/auth.json" ]; then
    h=$(hash_of "$CODEX_DIR/auth.json")
    if [ "$h" != "${LAST_AUTH:-}" ]; then
      if openssl enc -aes-256-cbc -pbkdf2 -pass env:LATERDOG_BACKUP_KEY -in "$CODEX_DIR/auth.json" -out "$DATA/.auth.enc" 2>/dev/null && put_state codex-auth.json.enc "$DATA/.auth.enc"; then LAST_AUTH=$h; fi
      rm -f "$DATA/.auth.enc"
    fi
  fi
  if [ -n "${LATERDOG_BACKUP_KEY:-}" ] && [ -f "$GH_DIR/hosts.yml" ]; then
    h=$(hash_of "$GH_DIR/hosts.yml")
    if [ "$h" != "${LAST_GH:-}" ]; then
      if openssl enc -aes-256-cbc -pbkdf2 -pass env:LATERDOG_BACKUP_KEY -in "$GH_DIR/hosts.yml" -out "$DATA/.gh.enc" 2>/dev/null && put_state gh-hosts.yml.enc "$DATA/.gh.enc"; then LAST_GH=$h; fi
      rm -f "$DATA/.gh.enc"
    fi
  fi
}

restore

# gh authenticates its own `gh repo clone`; the publisher's plain `git fetch`/`git push` need a credential helper too.
if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ] || gh auth status >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || log "gh auth setup-git failed; git push may lack credentials"
fi

node laterdog/main.js &
NODE_PID=$!
LOOP_PID=""
if [ -n "$STATE_URL" ]; then
  ( while :; do sleep "$INTERVAL"; backup; done ) &
  LOOP_PID=$!
fi

shutdown() {
  log "shutting down"
  [ -n "$LOOP_PID" ] && kill "$LOOP_PID" 2>/dev/null
  kill -TERM "$NODE_PID" 2>/dev/null
  # Give the supervisor a bounded time to drain, then force it: a lingering process would keep the whole instance alive.
  n=0
  while kill -0 "$NODE_PID" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 1; n=$((n + 1)); done
  kill -KILL "$NODE_PID" 2>/dev/null
  wait "$NODE_PID" 2>/dev/null
  backup
  log "final backup done; exiting"
  exit 0
}
trap shutdown TERM INT

wait "$NODE_PID"
code=$?
[ -n "$LOOP_PID" ] && kill "$LOOP_PID" 2>/dev/null
backup
exit "$code"
