import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { writeFileAtomicIfChanged } from "../atomic.ts";

export function prepareCodexShellGuard(
  env: NodeJS.ProcessEnv,
  threadId: string,
  hooks?: { url: string; token: string; guardShell?: boolean },
): void {
  delete env.LATERDOG_HOOK_URL;
  delete env.LATERDOG_HOOK_TOKEN_FILE;
  if (!hooks?.guardShell) return;
  const dir = join(DATA_DIR, "hook-tokens");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = createHash("sha256").update(`codex\0${threadId}`).digest("hex").slice(0, 24);
  const path = join(dir, `${name}.token`);
  writeFileAtomicIfChanged(path, hooks.token, { mode: 0o600, durable: false });
  env.LATERDOG_HOOK_URL = hooks.url;
  env.LATERDOG_HOOK_TOKEN_FILE = path;
}
