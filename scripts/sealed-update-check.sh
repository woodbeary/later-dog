#!/bin/bash
set -euo pipefail

OLD="${1:?older release tag, for example v0.3.21}"
PORT="${2:-19345}"
REPO="woodbeary/later-dog"
TRIAL_API="https://cloud.later.dog/v1"
JOB="dog.later.app.ShipIt"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
REAL_HOME=$(dscl . -read "/Users/$USER" NFSHomeDirectory | awk '{print $2}')
ROOT=$(mktemp -d /tmp/laterdog-sealed.XXXXXX)
SEALED="$ROOT/home"
APP="$ROOT/run/later.dog.app"
APP_PID=""
touch "$ROOT/started"
exec 3>&1 4>&2

bearer_header() {
  local header="$ROOT/header"
  (umask 077; printf 'Authorization: Bearer %s\n' "$(tr -d '\n' <"$1")" >"$header")
  echo "$header"
}

cleanup() {
  set +e +o pipefail
  exec 1>&3 2>&4
  if [ -s "$SEALED/.laterdog/computers-trial-key" ]; then
    header=$(bearer_header "$SEALED/.laterdog/computers-trial-key")
    curl -s -o /dev/null -w "ended the copy's free trial: HTTP %{http_code}\n" -X DELETE -H @"$header" "$TRIAL_API/trial" || true
    rm -f "$header"
  fi
  [ -n "$APP_PID" ] && kill -KILL "$APP_PID" 2>/dev/null
  pkill -KILL -f "$ROOT/run/" 2>/dev/null
  launchctl list "$JOB" >/dev/null 2>&1 && launchctl remove "$JOB" && echo "removed the copy's installer job"
  changed=$(find "$REAL_HOME/.laterdog" "$REAL_HOME/Library/Application Support/later.dog" -newer "$ROOT/started" -type f 2>/dev/null | grep -cv "/task-workspaces/")
  echo "files changed in the real later.dog folders during the run: $changed"
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
if launchctl list "$JOB" >/dev/null 2>&1; then
  echo "a $JOB job already exists (the real later.dog may be updating); try again later"
  exit 1
fi

mkdir -p "$ROOT/dl" "$ROOT/run" "$SEALED/tmp" "$SEALED/.laterdog"
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
gh release download "$OLD" --repo "$REPO" --pattern 'later.dog-macOS-arm64.zip' --pattern 'SHA256SUMS.txt'
shasum -a 256 -c SHA256SUMS.txt
ditto -x -k later.dog-macOS-arm64.zip "$ROOT/run/"
codesign --verify --deep --strict "$APP"
version_of() { /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null; }
OLD_VERSION=$(version_of)
NEW_VERSION=$(gh release view --repo "$REPO" --json tagName -q .tagName | sed 's/^v//')
[ "$OLD_VERSION" != "$NEW_VERSION" ] || { echo "$OLD is already the newest release"; exit 1; }

launch() {
  env -i HOME="$SEALED" CFFIXED_USER_HOME="$SEALED" LATERDOG_HOME="$SEALED/.laterdog" TMPDIR="$SEALED/tmp" \
    LATERDOG_SUPERVISOR_URL=http://127.0.0.1:9 LATERDOG_TOKEN=sealed-installed-check \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin USER="$USER" LANG=en_US.UTF-8 \
    "$APP/Contents/MacOS/later.dog" --no-sandbox --use-mock-keychain --remote-debugging-port="$PORT" >>"$ROOT/app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null || { echo "the app did not come up; log: $ROOT/app.log"; exit 1; }
  [ -d "$SEALED/Library/Application Support/later.dog" ] || { echo "the app did not use the sealed profile; stopping it"; exit 1; }
}
data_files() {
  (cd "$SEALED/.laterdog" && find . -type f 2>/dev/null) \
    | grep -vE '^\./tmp/|/logs?/|\.(lock|pid|sock|tmp|log)$|-(journal|wal|shm)$' | sort || true
}
running_version() {
  curl -sf "http://127.0.0.1:$PORT/json/version" | python3 -I -c 'import json,re,sys; m=re.search(r"later\.dog/([\d.]+)", json.load(sys.stdin)["User-Agent"]); print(m.group(1) if m else "unknown")'
}

launch
echo "later.dog $OLD_VERSION is running sealed (pid $APP_PID, devtools http://127.0.0.1:$PORT); waiting for it to stage $NEW_VERSION"
for _ in $(seq 1 120); do launchctl list "$JOB" >/dev/null 2>&1 && break; sleep 5; done
launchctl list "$JOB" >/dev/null 2>&1 || { echo "no installer job after 10 minutes; log: $ROOT/app.log"; exit 1; }
STATE="$SEALED/Library/Caches/$JOB/ShipItState.plist"
RELAUNCH=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("launchAfterInstallation"))' "$STATE" 2>/dev/null || echo unreadable)
if [ "$RELAUNCH" != "False" ]; then
  launchctl remove "$JOB"
  echo "the installer's request says launchAfterInstallation=$RELAUNCH; removed it rather than quit"
  exit 1
fi
echo "staged: the installer waits for the copy to quit and will not relaunch it"

if [ -n "${LATERDOG_UPDATE_QUIT_AFTER:-}" ]; then
  echo "waiting for $LATERDOG_UPDATE_QUIT_AFTER before quitting"
  while [ ! -e "$LATERDOG_UPDATE_QUIT_AFTER" ]; do sleep 2; done
fi
data_files >"$ROOT/files-before"

kill -TERM "$APP_PID"
for _ in $(seq 1 60); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
if kill -0 "$APP_PID" 2>/dev/null; then echo "the copy did not quit within 60 s; stopping it"; kill -KILL "$APP_PID"; fi
APP_PID=""
for _ in $(seq 1 240); do
  if pgrep -f "$APP/Contents/MacOS/later.dog" >/dev/null; then
    pkill -KILL -f "$APP/Contents/MacOS/later.dog"
    echo "the installer relaunched the copy outside its temporary home; stopped it"
    exit 1
  fi
  [ "$(version_of)" = "$NEW_VERSION" ] && break
  sleep 0.5
done
[ "$(version_of)" = "$NEW_VERSION" ] || { echo "the copy still reads $(version_of) two minutes after quitting"; exit 1; }
echo "installed on quit: $OLD_VERSION -> $NEW_VERSION"
launchctl list "$JOB" >/dev/null 2>&1 && launchctl remove "$JOB"
codesign --verify --deep --strict "$APP"
spctl -a -vv -t exec "$APP"

launch
echo "the updated copy reports later.dog $(running_version)"
missing=$(comm -23 "$ROOT/files-before" <(data_files))
if [ -n "$missing" ]; then
  echo "files gone from $SEALED/.laterdog after the update:"; echo "$missing"
  exit 1
fi
echo "all $(wc -l <"$ROOT/files-before" | tr -d ' ') data files from before the update are still there"
cat <<EOF
later.dog $NEW_VERSION is running sealed on the same home (pid $APP_PID)
  devtools  http://127.0.0.1:$PORT
  profile   $SEALED
It inherits this Mac's Accessibility and Screen Recording grants (same signed
app), so never give its dogs a task on "this Mac". Ctrl-C ends its free trial,
stops it and removes $ROOT.
EOF
wait "$APP_PID" || true
APP_PID=""
