#!/bin/bash
set -u
B="$(cd "$(dirname "$0")" && pwd)"
V=/Volumes/fable-native
NATIVE=$V/target-laterdog/release/laterdog
HOME_URL=$1
DOG=${DOG:-Biscuit}
RUNS=${RUNS:-5}
SETTLE=${SETTLE:-12}
OUT=$B/native-$(date +%Y%m%dT%H%M%S).tsv
now() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
cpu_seconds() { ps -o cputime= -p "$1" 2>/dev/null | awk -F: '{ if (NF==3) print $1*3600+$2*60+$3; else print $1*60+$2 }'; }

printf "run\tload1\tlaunch_to_drawn_ms\tinside_app_ms\tidle_mb\tidle_cpu_pct\n" > "$OUT"
for run in $(seq 0 "$RUNS"); do
  load=$(sysctl -n vm.loadavg | awk '{print $2}')
  P=$(mktemp -d $V/tmp/na.XXXXXX)
  start=$(now)
  LATERDOG_NATIVE_DATA="$P" LATERDOG_HOME_URL=$HOME_URL LATERDOG_TIMING=1 "$NATIVE" --select "$DOG" --size 1280x760 --snapshot "$P/s.png" > "$P/launch.log" 2>&1
  drawn=$(( $(now) - start ))
  inside=$(awk '/first page drawn/ {print $2; exit}' "$P/launch.log")
  LATERDOG_NATIVE_DATA="$P" LATERDOG_HOME_URL=$HOME_URL "$NATIVE" --select "$DOG" > "$P/idle.log" 2>&1 &
  pid=$!
  sleep "$SETTLE"
  mb=$(footprint "$pid" 2>/dev/null | awk '/phys_footprint:/ {v=$2; u=$3; if (u=="KB") v=v/1024; if (u=="GB") v=v*1024; printf "%.1f", v; exit}')
  c0=$(cpu_seconds "$pid"); sleep 10; c1=$(cpu_seconds "$pid")
  cpu=$(echo "($c1 - $c0) * 10" | bc -l | awk '{printf "%.1f", $1}')
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  [ "$run" -gt 0 ] && printf "%d\t%s\t%s\t%s\t%s\t%s\n" "$run" "$load" "$drawn" "${inside:-NA}" "${mb:-NA}" "$cpu" >> "$OUT"
  sleep 3
  rm -rf "$P"
done
cat "$OUT"
echo "results: $OUT"
