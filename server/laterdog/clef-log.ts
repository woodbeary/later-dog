import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { boundRetentionDays, pruneMonthFiles } from "../decision-log.ts";
import { monthKey } from "../usage-ledger.ts";

export const CLEF_LOG_DIR = "clef-log";
const PRUNE_EVERY_MS = 60 * 60_000;

export type ClefLogKind = "turnEnd" | "screenCheck" | "screenshotFilter" | "autoReview";

export interface ClefLogRow {
  kind: ClefLogKind;
  threadId?: string;
  botId?: string;
  [field: string]: string | number | boolean | null | undefined;
}

const writeQueues = new Map<string, Promise<void>>();
const lastPrune = new Map<string, number>();

export function clefLogFileFor(dataDir: string, at: Date): string {
  return join(dataDir, CLEF_LOG_DIR, `${monthKey(at)}.ndjson`);
}

async function write(dataDir: string, row: ClefLogRow, at: Date): Promise<void> {
  await mkdir(join(dataDir, CLEF_LOG_DIR), { recursive: true, mode: 0o700 });
  await appendFile(clefLogFileFor(dataDir, at), JSON.stringify({ at: at.toISOString(), ...row }) + "\n", { mode: 0o600 });
  if (at.getTime() - (lastPrune.get(dataDir) ?? 0) >= PRUNE_EVERY_MS) {
    lastPrune.set(dataDir, at.getTime());
    await pruneMonthFiles(join(dataDir, CLEF_LOG_DIR), boundRetentionDays(), at);
  }
}

export function appendClefLog(dataDir: string, row: ClefLogRow, at = new Date()): void {
  const previous = writeQueues.get(dataDir) ?? Promise.resolve();
  const queued = previous.then(() => write(dataDir, row, at)).catch(() => {});
  writeQueues.set(dataDir, queued);
  void queued.finally(() => {
    if (writeQueues.get(dataDir) === queued) writeQueues.delete(dataDir);
  });
}

export async function flushClefLog(dataDir: string): Promise<void> {
  await writeQueues.get(dataDir);
}
