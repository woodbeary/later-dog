export const SCREENSHOT_MAX_WIDTH = 1024;
export const SCREENSHOT_QUALITY = 60;

const SCALE = [
  "set -- $(xdotool getdisplaygeometry 2>/dev/null)",
  'W="${1:-0}"',
  'H="${2:-0}"',
  "P=100",
  `if [ "$W" -gt ${SCREENSHOT_MAX_WIDTH} ] 2>/dev/null; then P=$(( ${SCREENSHOT_MAX_WIDTH * 100} / W )); fi`,
].join("; ");

export function onScreen(value: unknown): string {
  return `$(( ${Math.max(0, Math.trunc(Number(value)) || 0)} * 100 / P ))`;
}

export function scaled(command: string): string {
  return `${SCALE}; ${command}`;
}

export const SCREEN_SIZE_COMMAND = scaled('echo "$(( W * P / 100 )) $(( H * P / 100 ))"');

export const SCREENSHOT_COMMAND = scaled([
  'd=$(mktemp -d) || exit 1',
  `trap 'rm -rf "$d"' EXIT`,
  `if [ "$P" -lt 100 ]; then scrot --overwrite --pointer --quality ${SCREENSHOT_QUALITY} --thumb "$P" "$d/s.jpg" >/dev/null && base64 -w0 "$d/s-thumb.jpg"; else scrot --overwrite --pointer --quality ${SCREENSHOT_QUALITY} "$d/s.jpg" >/dev/null && base64 -w0 "$d/s.jpg"; fi`,
].join("; "));

export function imageFromOutput(stdout: string): string | null {
  const data = stdout.trim();
  if (data.length < 100 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? data : null;
}
