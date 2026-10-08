#!/usr/bin/env bash
# Deploys later.dog's cloud computers to the Cloudflare account wrangler is logged in to, in one command:
#
#   pnpm run setup
#
# 1. installs this package's dependencies (standalone, outside the repo's workspace);
# 2. `wrangler deploy` builds the desktop image for linux/amd64 with your local Docker, pushes it to your account's
#    registry and deploys the Worker (the first build takes a while);
# 3. creates the API key ldc_... once, stores it only in ~/.laterdog/computers-key (mode 600), and sets the Worker secret
#    COMPUTERS_KEY_SHA256 to its SHA-256 (the key itself never leaves this machine);
# 4. sets DESKTOP_SIGNING_KEY to a fresh random value if the Worker does not have one yet;
# 5. waits until the Worker accepts the key, then writes ~/.laterdog/computers.json (mode 600) with the API base URL.
# Run it again after changing the code: it redeploys and keeps the existing key. No secret is ever printed.
set -euo pipefail
cd "$(dirname "$0")/.."

dir="$HOME/.laterdog"
key_file="$dir/computers-key"
mkdir -p "$dir"
chmod 700 "$dir"

pnpm install --ignore-workspace --frozen-lockfile
pnpm exec wrangler types >/dev/null

log=$(mktemp)
trap 'rm -f "$log"' EXIT
pnpm exec wrangler deploy 2>&1 | tee "$log"
url=$(grep -Eo 'https://laterdog-computers\.[A-Za-z0-9-]+\.workers\.dev' "$log" | head -1 || true)
if [ -z "$url" ]; then
  echo "Could not find the workers.dev URL in the deploy output; is a workers.dev subdomain enabled on this account?" >&2
  exit 1
fi

if [ ! -s "$key_file" ]; then
  (umask 077 && printf 'ldc_%s' "$(openssl rand -hex 32)" > "$key_file")
  echo "Created a new API key in $key_file"
fi
chmod 600 "$key_file"
tr -d '\n' < "$key_file" | shasum -a 256 | cut -d ' ' -f 1 | tr -d '\n' | pnpm exec wrangler secret put COMPUTERS_KEY_SHA256

if ! pnpm exec wrangler secret list --format json 2>/dev/null | grep -q '"DESKTOP_SIGNING_KEY"'; then
  openssl rand -base64 48 | tr -d '\n' | pnpm exec wrangler secret put DESKTOP_SIGNING_KEY
fi

# A new workers.dev route and new secrets can take a few seconds to answer. The header goes to curl on stdin, so the key
# never appears in the process list.
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

# Written last, once the Worker answers with both secrets set: later.dog's server uses these computers (instead of Boat)
# as soon as this file exists (server/laterdog/cloud-computers.ts).
(umask 077 && printf '{ "api": "%s/v1" }\n' "$url" > "$dir/computers.json")
chmod 600 "$dir/computers.json"
echo "API: $url/v1 (key in $key_file; base URL in $dir/computers.json)"
