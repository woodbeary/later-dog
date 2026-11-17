#!/bin/bash
set -u
B="$(cd "$(dirname "$0")" && pwd)"
W=/Users/jacoblopez/code/.wt/fable-send
V=/Volumes/fable-native
NATIVE=$V/target-laterdog/release/laterdog
HOME_URL=http://127.0.0.1:20418
WEB_URL=http://127.0.0.1:20499/
RUNS=${RUNS:-5}
OUT=$B/results-$(date +%Y%m%dT%H%M%S).tsv
SETTLE=${SETTLE:-12}

tree_footprint() {
  local total=0 count=0 f
  for p in "$@"; do
    f=$(footprint "$p" 2>/dev/null | awk '/phys_footprint:/ {v=$2; u=$3; if (u=="KB") v=v/1024; if (u=="GB") v=v*1024; print v; exit}')
    [ -n "$f" ] && { total=$(echo "$total + $f" | bc -l); count=$((count + 1)); }
  done
  printf "%.0f\t%d" "$total" "$count"
}

tree_cpu_seconds() {
  local total=0 t
  for p in "$@"; do
    t=$(ps -o cputime= -p "$p" 2>/dev/null | awk -F: '{ if (NF==3) print $1*3600+$2*60+$3; else print $1*60+$2 }')
    [ -n "$t" ] && total=$(echo "$total + $t" | bc -l)
  done
  echo "$total"
}

printf "app\trun\tload1\tready_ms\tidle_mb\tprocs\tidle_cpu_pct\n" > "$OUT"

for run in $(seq 1 "$RUNS"); do
  for app in electron native; do
    load=$(sysctl -n vm.loadavg | awk '{print $2}')
    start=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
    if [ "$app" = electron ]; then
      P=$(mktemp -d $V/tmp/el.XXXXXX)
      "$W/node_modules/.bin/electron" "$B/shell.cjs" --user-data-dir="$P" "$WEB_URL" Marathon > "$B/last.log" 2>&1 &
      match="user-data-dir=$P"
    else
      P=$(mktemp -d $V/tmp/na.XXXXXX)
      LATERDOG_NATIVE_DATA="$P" LATERDOG_HOME_URL=$HOME_URL LATERDOG_TIMING=1 "$NATIVE" --select Marathon > "$B/last.log" 2>&1 &
      match="$NATIVE"
    fi
    ready=""
    for i in $(seq 1 1500); do
      if [ "$app" = electron ]; then grep -q '^READY' "$B/last.log" && ready=1; else grep -q 'first page drawn' "$B/last.log" && ready=1; fi
      [ -n "$ready" ] && break
      sleep 0.02
    done
    now=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
    if [ -n "$ready" ]; then ready=$((now - start)); fi
    sleep "$SETTLE"
    pids=$(pgrep -f "$match")
    read -r mb procs <<< "$(tree_footprint $pids)"
    c0=$(tree_cpu_seconds $pids); sleep 10; c1=$(tree_cpu_seconds $pids)
    cpu=$(echo "($c1 - $c0) * 10" | bc -l | awk '{printf "%.1f", $1}')
    printf "%s\t%d\t%s\t%s\t%s\t%s\t%s\n" "$app" "$run" "$load" "${ready:-NA}" "$mb" "$procs" "$cpu" >> "$OUT"
    pkill -f "$match" 2>/dev/null
    sleep 3
    rm -rf "$P"
  done
done
cat "$OUT"
echo "results: $OUT"
