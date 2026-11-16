import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteExec } from "../../server/cloud-computer-tools.ts";
import { localExec } from "./no-vision.ts";

const FAKE_XDOTOOL = `#!/bin/sh
case "$1" in
  getdisplaygeometry) echo "1280 800" ;;
  getmouselocation) printf 'X=%s\\nY=%s\\nSCREEN=0\\nWINDOW=1\\n' "$(cat "$FAKE_POINTER_X" 2>/dev/null || echo 9)" "$(cat "$FAKE_POINTER_Y" 2>/dev/null || echo 9)" ;;
  *) echo "$@" >> "$FAKE_XDOTOOL_LOG" ;;
esac
`;

export function fakeXdotool(pointer?: { x: number; y: number }): { exec: RemoteExec; log(): string[] } {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-fake-xdotool-"));
  writeFileSync(join(dir, "xdotool"), FAKE_XDOTOOL);
  chmodSync(join(dir, "xdotool"), 0o755);
  const logFile = join(dir, "calls.log");
  writeFileSync(logFile, "");
  const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? ""}`, FAKE_XDOTOOL_LOG: logFile };
  if (pointer) {
    writeFileSync(join(dir, "x"), String(pointer.x));
    writeFileSync(join(dir, "y"), String(pointer.y));
    env.FAKE_POINTER_X = join(dir, "x");
    env.FAKE_POINTER_Y = join(dir, "y");
  }
  return { exec: localExec(env), log: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean) };
}

