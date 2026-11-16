import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteExec } from "../../server/cloud-computer-tools.ts";
import { localExec } from "./no-vision.ts";

const FAKE_XDOTOOL = `#!/bin/sh
case "$1" in
  getdisplaygeometry) echo "1280 800" ;;
  getmouselocation) printf 'X=%s\\nY=%s\\nSCREEN=0\\nWINDOW=1\\n' "$(cat "$FAKE_POINTER_X" 2>/dev/null || echo 9)" "$(cat "$FAKE_POINTER_Y" 2>/dev/null || echo 9)" ;;
  getactivewindow) echo 77 ;;
  getwindowgeometry) printf 'WINDOW=77\\nX=0\\nY=0\\nWIDTH=1280\\nHEIGHT=800\\nSCREEN=0\\n' ;;
  *) echo "$@" >> "$FAKE_XDOTOOL_LOG" ;;
esac
`;

const FAKE_XPROP = `#!/bin/sh
echo 'WM_CLASS(STRING) = "chromium", "Chromium"'
`;

const FAKE_XCLIP = `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "-o" ]; then
    if [ -s "$FAKE_CLIPBOARD" ]; then cat "$FAKE_CLIPBOARD"; else echo "https://login.example.test/sign-in"; fi
    exit 0
  fi
done
cat > "$FAKE_CLIPBOARD"
`;

export function fakeXdotool(pointer?: { x: number; y: number }): { exec: RemoteExec; log(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-fake-xdotool-"));
  for (const [name, script] of [["xdotool", FAKE_XDOTOOL], ["xprop", FAKE_XPROP], ["xclip", FAKE_XCLIP]]) {
    writeFileSync(join(dir, name!), script!);
    chmodSync(join(dir, name!), 0o755);
  }
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? ""}`, FAKE_XDOTOOL_LOG: logFile, FAKE_CLIPBOARD: join(dir, "clipboard") };
  if (pointer) {
    writeFileSync(join(dir, "x"), String(pointer.x));
    writeFileSync(join(dir, "y"), String(pointer.y));
    env.FAKE_POINTER_X = join(dir, "x");
    env.FAKE_POINTER_Y = join(dir, "y");
  }
  return { exec: localExec(env), log: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean) };
}

