import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function signedInGrokHome(dataDir: string): string {
  const home = join(dataDir, "grok-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "auth.json"), "{\"fixture\":\"offline, not a credential\"}\n", { mode: 0o600 });
  return home;
}
