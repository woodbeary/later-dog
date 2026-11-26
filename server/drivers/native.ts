import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";

export interface NativeEntry { dir: "in" | "out"; source: string; msg: unknown }
let relay: ((threadId: string, entry: NativeEntry) => void) | undefined;

export function relayNativeEntries(send: (threadId: string, entry: NativeEntry) => void) {
  relay = send;
}

export function appendNative(threadId: string, entry: NativeEntry) {
  const safe = { ...entry, msg: redactSecrets(entry.msg) };
  if (relay) { relay(threadId, safe); return; }
  const file = join(NATIVE_DIR, `${threadId}.ndjson`);
  try {
    appendFileSync(
      file,
      JSON.stringify({ at: new Date().toISOString(), ...safe }) + "\n",
      { mode: 0o600 },
    );
    capThreadLog(file, currentThreadLogCap());
  } catch {}
}
