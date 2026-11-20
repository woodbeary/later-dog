import { CLOUD_TABS_CDP_PORT } from "./cloud-tabs.ts";

const MIB = 1024 * 1024;

export interface UpkeepLimits {
  cacheBytes: number;
  downloadHours: number;
  partialDownloadMinutes: number;
  tempHours: number;
  runawayMinutes: number;
  runawayCpuPercent: number;
}

export const UPKEEP_LIMITS: UpkeepLimits = {
  cacheBytes: 256 * MIB,
  downloadHours: 24,
  partialDownloadMinutes: 60,
  tempHours: 24,
  runawayMinutes: 30,
  runawayCpuPercent: 50,
};

export interface UpkeepPlaces { home: string; temp: string; cache: string }
export const COMPUTER_PLACES: UpkeepPlaces = { home: '"$HOME"', temp: "/tmp", cache: '"$HOME/.cache/chromium"' };
export const UPKEEP_REPORT = "<<laterdog-upkeep>>";
const DESKTOP_PROGRAMS = "^(Xvfb|x11vnc|xf|dbus|chrom|at-spi|gvfs|[Tt]hunar|tumblerd|wrapper-|websockify)";
const DEVTOOLS_VERSION = `http://127.0.0.1:\${LATERDOG_PAGE_CDP_PORT:-${CLOUD_TABS_CDP_PORT}}/json/version`;

const CLEAR_CACHE_SOURCE = `
setTimeout(() => process.exit(2), 10000);
const base = "http://127.0.0.1:" + (Number(process.env.LATERDOG_PAGE_CDP_PORT) || ${CLOUD_TABS_CDP_PORT});
const pages = (await (await fetch(base + "/json/list", { signal: AbortSignal.timeout(2000) })).json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!pages.length) process.exit(1);
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((opened, failed) => { socket.onopen = opened; socket.onerror = failed; });
await new Promise((answered) => { socket.onmessage = answered; socket.send(JSON.stringify({ id: 1, method: "Network.clearBrowserCache" })); });
socket.close();
process.exit(0);
`;
const CLEAR_CACHE_B64 = Buffer.from(CLEAR_CACHE_SOURCE).toString("base64");

export function computerUpkeepScript(limits: UpkeepLimits = UPKEEP_LIMITS, places: UpkeepPlaces = COMPUTER_PLACES): string {
  const whole = (value: number) => Math.max(1, Math.round(value));
  const cacheKb = whole(limits.cacheBytes / 1024);
  const downloadMinutes = whole(limits.downloadHours * 60);
  const partialMinutes = whole(limits.partialDownloadMinutes);
  const tempMinutes = whole(limits.tempHours * 60);
  const runawaySeconds = whole(limits.runawayMinutes * 60);
  const caches = ["Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache", "DawnGraphiteCache", "DawnWebGPUCache"]
    .map((name) => `-name '${name}'`).join(" -o ");
  return [
    `kb() { du -sk "$@" 2>/dev/null | awk '{ total += $1 } END { print total + 0 }'; }`,
    `cache=${places.cache}; downloads=${places.home}/Downloads; temp=${places.temp}; reports=${places.home}/.config/chromium/'Crash Reports'`,
    `before=$(kb "$cache" "$downloads" "$temp" "$reports")`,
    `if [ "$(kb "$cache")" -gt ${cacheKb} ]; then`,
    `  if curl -s -m 2 ${DEVTOOLS_VERSION} >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then node --input-type=module -e "$(printf %s '${CLEAR_CACHE_B64}' | base64 -d)" >/dev/null 2>&1`,
    `  else find "$cache" -maxdepth 3 -type d \\( ${caches} \\) -prune -exec rm -rf {} + 2>/dev/null; fi`,
    `fi`,
    `if [ -d "$downloads" ]; then`,
    `  find "$downloads" -xdev -mindepth 1 -type f \\( -name '*.crdownload' -mmin +${partialMinutes} -o -mmin +${downloadMinutes} \\) -delete 2>/dev/null`,
    `  find "$downloads" -xdev -mindepth 1 -type d -empty -mmin +${downloadMinutes} -delete 2>/dev/null`,
    `fi`,
    `find "$temp" -xdev -mindepth 1 -user "$(id -u)" -type f -mmin +${tempMinutes} -delete 2>/dev/null`,
    `find "$temp" -xdev -mindepth 1 -user "$(id -u)" -type d -empty -mmin +${tempMinutes} -delete 2>/dev/null`,
    `[ -d "$reports" ] && find "$reports" -mindepth 1 -type f -mmin +${tempMinutes} -delete 2>/dev/null`,
    `after=$(kb "$cache" "$downloads" "$temp" "$reports")`,
    `stopped=0; stopping=""`,
    `for pid in $(ps -u "$(id -u)" -o pid=,etimes=,pcpu=,comm= 2>/dev/null | awk -v me=$$ -v secs=${runawaySeconds} -v cpu=${limits.runawayCpuPercent} '$1 != me && $2 >= secs && $3 >= cpu && $4 !~ /${DESKTOP_PROGRAMS}/ { print $1 }'); do`,
    `  if tr '\\0' '\\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^LATERDOG_RUN_ID='; then continue; fi`,
    `  if kill -TERM "$pid" 2>/dev/null; then stopped=$((stopped + 1)); stopping="$stopping $pid"; fi`,
    `done`,
    `if [ -n "$stopping" ]; then sleep 3; for pid in $stopping; do kill -KILL "$pid" 2>/dev/null; done; fi`,
    `printf '%s freed_kb=%s stopped=%s\\n' '${UPKEEP_REPORT}' "$(( before > after ? before - after : 0 ))" "$stopped"`,
  ].join("\n");
}

export function readUpkeepReport(text: string): { freedBytes: number; stopped: number } | null {
  const found = new RegExp(`${UPKEEP_REPORT} freed_kb=(\\d+) stopped=(\\d+)`).exec(text);
  return found ? { freedBytes: Number(found[1]) * 1024, stopped: Number(found[2]) } : null;
}
