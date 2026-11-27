import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SEARCH_INDEX_MODES, type SearchIndexMode } from "./search-index-wiring.ts";

const FILE = "search-index.json";

export function readSearchIndexMode(dataDir: string): SearchIndexMode {
  const file = join(dataDir, FILE);
  if (!existsSync(file)) return "off";
  try {
    const mode: unknown = (JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown }).mode;
    return (SEARCH_INDEX_MODES as readonly unknown[]).includes(mode) ? mode as SearchIndexMode : "off";
  } catch {
    return "off";
  }
}

export function saveSearchIndexMode(dataDir: string, mode: SearchIndexMode): void {
  const file = join(dataDir, FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ mode })}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
