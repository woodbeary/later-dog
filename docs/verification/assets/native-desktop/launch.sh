#!/bin/bash
set -u
B="$(cd "$(dirname "$0")" && pwd)"
W=/Users/jacoblopez/code/.wt/fable-send
V=/Volumes/fable-native
NATIVE=$V/target-laterdog/release/laterdog
HOME_URL=$1
WEB_URL=$2
RUNS=${RUNS:-7}
OUT=$B/launch-$(date +%Y%m%dT%H%M%S).tsv
now() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }

printf "app\trun\tload1\tlaunch_to_chat_ms\tinside_app_ms\n" > "$OUT"
for run in $(seq 0 "$RUNS"); do
  for app in electron native; do
    load=$(sysctl -n vm.loadavg | awk '{print $2}')
    if [ "$app" = electron ]; then
      P=$(mktemp -d $V/tmp/el.XXXXXX)
      start=$(now)
      "$W/node_modules/.bin/electron" "$B/shell.cjs" --user-data-dir="$P" "$WEB_URL" Marathon > "$B/last.log" 2>&1 &
      ready=""
      for i in $(seq 1 3000); do grep -q '^READY' "$B/last.log" && { ready=$(( $(now) - start )); break; }; sleep 0.01; done
      inside=$(awk '/^READY/ {print $2; exit}' "$B/last.log")
      pkill -f "user-data-dir=$P" 2>/dev/null
    else
      P=$(mktemp -d $V/tmp/na.XXXXXX)
      start=$(now)
      LATERDOG_NATIVE_DATA="$P" LATERDOG_HOME_URL=$HOME_URL LATERDOG_TIMING=1 "$NATIVE" --select Marathon --size 1280x760 --snapshot "$P/s.png" > "$B/last.log" 2>&1
      ready=$(( $(now) - start ))
      inside=$(awk '/first page drawn/ {print $2; exit}' "$B/last.log")
    fi
    [ "$run" -gt 0 ] && printf "%s\t%d\t%s\t%s\t%s\n" "$app" "$run" "$load" "${ready:-NA}" "${inside:-NA}" >> "$OUT"
    sleep 3
    rm -rf "$P"
  done
done
cat "$OUT"
echo "results: $OUT"
