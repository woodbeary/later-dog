#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

dir="$HOME/.laterdog"
key_file="$dir/computers-key"
mkdir -p "$dir"
chmod 700 "$dir"

pnpm install --ignore-workspace --frozen-lockfile
pnpm exec wrangler types >/dev/null

url="${LATERDOG_COMPUTERS_URL:-https://cloud.later.dog}"
url="${url%/}"
pnpm exec wrangler deploy

if [ ! -s "$key_file" ]; then
  (umask 077 && printf 'ldc_%s' "$(openssl rand -hex 32)" > "$key_file")
  echo "Created a new API key in $key_file"
fi
chmod 600 "$key_file"
tr -d '\n' < "$key_file" | shasum -a 256 | cut -d ' ' -f 1 | tr -d '\n' | pnpm exec wrangler secret put COMPUTERS_KEY_SHA256

secrets="$(pnpm exec wrangler secret list --format json)" || { echo "Could not list the Worker's secrets, so DESKTOP_SIGNING_KEY was left alone." >&2; exit 1; }
if ! grep -q '"DESKTOP_SIGNING_KEY"' <<<"$secrets"; then
  openssl rand -base64 48 | tr -d '\n' | pnpm exec wrangler secret put DESKTOP_SIGNING_KEY
fi

status=000
for _ in $(seq 1 30); do
  status=$(printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$key_file")" | curl -s -o /dev/null -w '%{http_code}' -H @- "$url/v1/computers" || true)
  [ "$status" = 200 ] && break
  sleep 2
done
if [ "$status" != 200 ]; then
  echo "The Worker did not accept the key at $url/v1/computers (last answer: HTTP $status)." >&2
  exit 1
fi

(umask 077 && printf '{ "api": "%s/v1" }\n' "$url" > "$dir/computers.json")
chmod 600 "$dir/computers.json"
echo "API: $url/v1 (key in $key_file; base URL in $dir/computers.json)"
