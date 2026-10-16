#!/bin/bash
set -euo pipefail

TAG="${1:?release tag, for example v0.3.17}"
PORT="${2:-19344}"
CANDIDATE=""
if [ -d "$TAG" ]; then
  CANDIDATE=$(cd "$TAG" && pwd)
  TAG=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag"])' "$CANDIDATE/candidate.json")
fi
REPO="woodbeary/later-dog"
TRIAL_API="https://cloud.later.dog/v1"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
REAL_HOME=$(dscl . -read "/Users/$USER" NFSHomeDirectory | awk '{print $2}')
ROOT=$(mktemp -d /tmp/laterdog-sealed.XXXXXX)
SEALED="$ROOT/home"
APP_PID=""

bearer_header() {
  local header="$ROOT/header"
  (umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '\n' <"$1")" >"$header")
  echo "$header"
}

cleanup() {
  set +e +o pipefail
  if [ -s "$SEALED/.laterdog/computers-trial-key" ]; then
    header=$(bearer_header "$SEALED/.laterdog/computers-trial-key")
    curl -s -o /dev/null -w "ended the copy's free trial: HTTP %{http_code}\n" -X DELETE -H @"$header" "$TRIAL_API/trial" || true
    rm -f "$header"
  fi
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null && wait "$APP_PID" 2>/dev/null || true
  find "$ROOT" -type d -name "*.app" 2>/dev/null | while IFS= read -r app; do
    "$LSREGISTER" -u "$app" 2>/dev/null || true
  done
  rm -rf "$ROOT"
  echo "stopped; removed $ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if lsof -nP -iTCP:8799 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "something already serves on port 8799 (a running later.dog?); quit it first"
  exit 1
fi

mkdir -p "$ROOT/dl" "$ROOT/verify" "$ROOT/run" "$SEALED/tmp" "$SEALED/.laterdog"
if [ -n "${LATERDOG_TRIAL_GRANT_KEY_FILE:-}" ]; then
  trial_key="ldt_$(openssl rand 32 | base64 | tr '+/' '-_' | tr -d '=\n')"
  claim=$(printf '%s' "$trial_key" | shasum -a 256 | awk '{print $1}')
  header=$(bearer_header "$LATERDOG_TRIAL_GRANT_KEY_FILE")
  status=$(curl -s -o "$ROOT/grant.json" -w "%{http_code}" -X POST -H @"$header" -H "content-type: application/json" \
    --data "{\"claim\":\"$claim\"}" "$TRIAL_API/trials/grant")
  rm -f "$header"
  [ "$status" = "200" ] || [ "$status" = "201" ] || { echo "trial grant refused: HTTP $status $(head -c 300 "$ROOT/grant.json")"; exit 1; }
  (umask 077; printf '%s\n' "$trial_key" >"$SEALED/.laterdog/computers-trial-key")
  printf '{"api":"%s","confirmed":true,"included":["decisions","voice","ai"]}\n' "$TRIAL_API" >"$SEALED/.laterdog/computers-trial.json"
  unset trial_key
  echo "granted the copy its own free trial"
fi
cd "$ROOT/dl"
if [ -n "$CANDIDATE" ]; then
  cp "$CANDIDATE/later.dog-macOS-arm64.zip" "$CANDIDATE/later.dog-macOS-arm64.dmg" "$CANDIDATE/SHA256SUMS.txt" "$CANDIDATE/latest-mac.yml" .
else
  gh release download "$TAG" --repo "$REPO" \
    --pattern 'later.dog-macOS-arm64.zip' --pattern 'later.dog-macOS-arm64.dmg' --pattern 'SHA256SUMS.txt' --pattern 'latest-mac.yml'
fi
awk '$2 == "later.dog-macOS-arm64.zip"' SHA256SUMS.txt | shasum -a 256 -c -
awk '$2 == "later.dog-macOS-arm64.dmg"' SHA256SUMS.txt | shasum -a 256 -c -
hdiutil verify later.dog-macOS-arm64.dmg
codesign --verify --strict later.dog-macOS-arm64.dmg
xcrun stapler validate later.dog-macOS-arm64.dmg
spctl -a -vv -t open --context context:primary-signature later.dog-macOS-arm64.dmg
python3 -I - latest-mac.yml later.dog-macOS-arm64.zip <<'EOF'
import base64, hashlib, re, sys
manifest = open(sys.argv[1]).read()
want = re.search(r'sha512:\s*"?([^"\s]+)', manifest).group(1)
got = base64.b64encode(hashlib.sha512(open(sys.argv[2], "rb").read()).digest()).decode()
if want != got:
    sys.exit("latest-mac.yml sha512 does not match the zip: updates to this release would fail")
print("latest-mac.yml sha512 matches the zip")
EOF

xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" later.dog-macOS-arm64.zip
ditto -x -k later.dog-macOS-arm64.zip "$ROOT/verify/"
codesign --verify --deep --strict "$ROOT/verify/later.dog.app"
spctl -a -vv -t exec "$ROOT/verify/later.dog.app"
xcrun stapler validate "$ROOT/verify/later.dog.app"

ditto "$ROOT/verify/later.dog.app" "$ROOT/run/later.dog.app"
xattr -cr "$ROOT/run/later.dog.app"

PROFILE="(version 1)(allow default)
(deny file-read* file-write*
  (subpath \"$REAL_HOME/.laterdog\")
  (subpath \"$REAL_HOME/Library/Application Support/later.dog\")
  (subpath \"$REAL_HOME/.claude\")
  (subpath \"$REAL_HOME/.codex\"))"
env -i HOME="$SEALED" CFFIXED_USER_HOME="$SEALED" LATERDOG_HOME="$SEALED/.laterdog" TMPDIR="$SEALED/tmp" \
  LATERDOG_SUPERVISOR_URL=http://127.0.0.1:9 LATERDOG_TOKEN=sealed-installed-check \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin USER="$USER" LANG=en_US.UTF-8 \
  /usr/bin/sandbox-exec -p "$PROFILE" "$ROOT/run/later.dog.app/Contents/MacOS/later.dog" \
  --no-sandbox --use-mock-keychain --remote-debugging-port="$PORT" >"$ROOT/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null || { echo "the app did not come up; log: $ROOT/app.log"; exit 1; }
[ -d "$SEALED/Library/Application Support/later.dog" ] || { echo "the app did not use the sealed profile; stopping it"; exit 1; }

cat <<EOF
later.dog $TAG is running sealed (pid $APP_PID)
  devtools  http://127.0.0.1:$PORT
  profile   $SEALED
  log       $ROOT/app.log
It inherits this Mac's Accessibility and Screen Recording grants (same signed
app), so never give its dogs a task on "this Mac". Ctrl-C ends its free trial,
stops it and removes $ROOT.
EOF
wait "$APP_PID" || true
APP_PID=""
