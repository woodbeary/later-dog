import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CLOUD_NOBODY_KEY = `p_${createHash("sha256").update("cloud-nobody").digest("base64url").slice(0, 22)}`;

export function markLeftBehind(dataDir: string, of: { threadIds?: readonly string[]; routineIds?: readonly string[]; legacyResults?: Readonly<Record<string, string>> }): void {
  const read = (name: string) => {
    const file = join(dataDir, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, any> : null;
  };
  if (of.threadIds?.length) {
    const starters = read("thread-starters.json") ?? {};
    for (const threadId of of.threadIds) starters[threadId] = CLOUD_NOBODY_KEY;
    writeFileSync(join(dataDir, "thread-starters.json"), JSON.stringify(starters), { mode: 0o600 });
  }
  if (of.routineIds?.length) {
    const authors = read("lending-routines.json") ?? { version: 1, routines: {}, writers: {} };
    authors.writers ??= {};
    for (const routineId of of.routineIds) {
      delete authors.routines[routineId];
      authors.writers[routineId] = CLOUD_NOBODY_KEY;
    }
    writeFileSync(join(dataDir, "lending-routines.json"), JSON.stringify(authors), { mode: 0o600 });
  }
  if (of.legacyResults && Object.keys(of.legacyResults).length) {
    const saved = read("routines.json");
    if (!saved) throw new Error("No routines.json to give a legacy results thread");
    for (const routine of saved.routines ?? []) {
      const results = of.legacyResults[routine.id];
      if (results) routine.resultsThreadId = results;
    }
    writeFileSync(join(dataDir, "routines.json"), JSON.stringify(saved), { mode: 0o600 });
  }
}
