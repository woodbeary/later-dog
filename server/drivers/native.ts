import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecrets(entry.msg) }) + "\n",
      { mode: 0o600 },
    );
    capThreadLog(file, currentThreadLogCap());
  } catch {}
}
