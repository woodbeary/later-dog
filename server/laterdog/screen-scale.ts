export const SCREENSHOT_MAX_WIDTH = 1024;
export const SCREENSHOT_QUALITY = 60;

const SCALE = [
  "set -- $(xdotool getdisplaygeometry 2>/dev/null)",
  'W="${1:-0}"',
  'H="${2:-0}"',
  "P=100",
  `if [ "$W" -gt ${SCREENSHOT_MAX_WIDTH} ] 2>/dev/null; then P=$(( ${SCREENSHOT_MAX_WIDTH * 100} / W )); fi`,
].join("; ");

const FULL_SIZE = [
  "set -- $(xdotool getdisplaygeometry 2>/dev/null)",
  'W="${1:-0}"',
  'H="${2:-0}"',
  "P=100",
].join("; ");

export function onScreen(value: unknown): string {
  return `$(( ${Math.max(0, Math.trunc(Number(value)) || 0)} * 100 / P ))`;
}

export function pointerTo(x: unknown, y: unknown): string {
  return [
    `TX=${onScreen(x)}`,
    `TY=${onScreen(y)}`,
    'eval "$(xdotool getmouselocation --shell 2>/dev/null | grep -E \'^[XY]=[0-9]+$\')"',
    'if [ "${X:-}" != "$TX" ] || [ "${Y:-}" != "$TY" ]; then xdotool mousemove --sync "$TX" "$TY"; fi',
  ].join("; ");
}

export function scaled(command: string, fullSize = false): string {
  return `${fullSize ? FULL_SIZE : SCALE}; ${command}`;
}

export function screenSizeCommand(fullSize = false): string {
  return scaled('echo "$(( W * P / 100 )) $(( H * P / 100 ))"', fullSize);
}

export const SCREEN_SIZE_COMMAND = screenSizeCommand();

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

const whole = (value: unknown) => Math.max(0, Math.trunc(Number(value)) || 0);

export function zoomCommand(region: { x: unknown; y: unknown; width: unknown; height: unknown }, fullSize = false): string {
  return scaled([
    `X=$(( ${whole(region.x)} * 100 / P ))`,
    `Y=$(( ${whole(region.y)} * 100 / P ))`,
    `RW=$(( ${whole(region.width)} * 100 / P ))`,
    `RH=$(( ${whole(region.height)} * 100 / P ))`,
    'if [ "$X" -ge "$W" ]; then X=$(( W - 1 )); fi',
    'if [ "$Y" -ge "$H" ]; then Y=$(( H - 1 )); fi',
    'if [ $(( X + RW )) -gt "$W" ]; then RW=$(( W - X )); fi',
    'if [ $(( Y + RH )) -gt "$H" ]; then RH=$(( H - Y )); fi',
    'if [ "$RW" -lt 1 ]; then RW=1; fi',
    'if [ "$RH" -lt 1 ]; then RH=1; fi',
    "Q=100",
    `if [ "$RW" -gt ${SCREENSHOT_MAX_WIDTH} ]; then Q=$(( ${SCREENSHOT_MAX_WIDTH * 100} / RW )); fi`,
    "d=$(mktemp -d) || exit 1",
    `trap 'rm -rf "$d"' EXIT`,
    `if [ "$Q" -lt 100 ]; then scrot --overwrite --pointer --quality ${SCREENSHOT_QUALITY} --autoselect "$X,$Y,$RW,$RH" --thumb "$Q" "$d/z.jpg" >/dev/null && base64 -w0 "$d/z-thumb.jpg"; else scrot --overwrite --pointer --quality ${SCREENSHOT_QUALITY} --autoselect "$X,$Y,$RW,$RH" "$d/z.jpg" >/dev/null && base64 -w0 "$d/z.jpg"; fi`,
  ].join("; "), fullSize);
}
