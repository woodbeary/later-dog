export const SCREENSHOT_SCRIPT = `f=$(mktemp --suffix=.jpg) || exit 1; trap 'rm -f "$f"' EXIT; scrot --overwrite --pointer --quality 75 "$f" >/dev/null && cat -- "$f"`;

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const buttons: Record<string, number> = { left: 1, middle: 2, right: 3 };
const scrollButtons: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 };

export type ScreenAction =
  | { tool: "click"; x: number; y: number; button?: "left" | "middle" | "right"; count?: number }
  | { tool: "type_text"; text: string }
  | { tool: "key_press"; key: string }
  | { tool: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number };

export function screenCommand(action: ScreenAction): string {
  switch (action.tool) {
    case "click": return `xdotool mousemove --sync ${action.x} ${action.y} click --repeat ${action.count ?? 1} --delay 100 ${buttons[action.button ?? "left"]}`;
    case "type_text": return `printf %s ${quote(Buffer.from(action.text).toString("base64"))} | base64 -d | xclip -selection clipboard && xdotool key --clearmodifiers ctrl+v`;
    case "key_press": return `xdotool key --clearmodifiers ${quote(action.key)}`;
    case "scroll": return `xdotool mousemove --sync ${action.x} ${action.y} click --repeat ${action.amount ?? 3} --delay 80 ${scrollButtons[action.direction]}`;
  }
}

export function screenActionResultText(result: { ok: boolean; exitCode: number | null; stdout: string; stderr: string }): string {
  return JSON.stringify(result);
}

export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export function imageTokens(width: number, height: number): number {
  const longEdge = 1568;
  const maxPixels = 1_150_000;
  let scale = Math.min(1, longEdge / Math.max(width, height));
  if (width * height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (width * height));
  return Math.ceil((Math.round(width * scale) * Math.round(height * scale)) / 750);
}

export const textTokens = (bytes: number) => Math.ceil(bytes / 4);
