import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";
import { readOwnedJson } from "./owned-file.ts";

export const REMOVED_DOG_SETTINGS_FILE = "removed-dog-settings.json";

export interface RemovedDogSettings {
  id: string;
  name: string;
  outbound?: unknown;
  connectorScopes?: unknown;
  removedAt: string;
}

interface DogWithRetiredSettings {
  id: string;
  name: string;
  outbound?: unknown;
  connectorScopes?: unknown;
}

function removedList(raw: unknown): RemovedDogSettings[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry) && typeof entry.id === "string")
    ? raw as RemovedDogSettings[]
    : undefined;
}

const sameSettings = (entry: Pick<RemovedDogSettings, "id" | "outbound" | "connectorScopes">) =>
  JSON.stringify([entry.id, entry.outbound, entry.connectorScopes]);

export function setAsideRemovedDogSettings(
  dataDir: string,
  bots: DogWithRetiredSettings[],
  now: () => Date = () => new Date(),
): boolean {
  const holding = bots.filter((bot) => bot.outbound !== undefined || bot.connectorScopes !== undefined);
  if (!holding.length) return false;
  const file = join(dataDir, REMOVED_DOG_SETTINGS_FILE);
  const saved = readOwnedJson(file, removedList, now);
  if (saved.state === "damaged" && saved.keptAs === null) {
    console.warn(`[removed-dog-settings] ${REMOVED_DOG_SETTINGS_FILE} could not be read or copied; kept the old send and app settings on the dogs for now`);
    return false;
  }
  const kept = saved.state === "ok" ? saved.value : [];
  const known = new Set(kept.map(sameSettings));
  const removedAt = now().toISOString();
  const added: RemovedDogSettings[] = [];
  for (const bot of holding) {
    const entry: RemovedDogSettings = {
      id: bot.id,
      name: typeof bot.name === "string" ? bot.name : "",
      ...(bot.outbound !== undefined ? { outbound: bot.outbound } : {}),
      ...(bot.connectorScopes !== undefined ? { connectorScopes: bot.connectorScopes } : {}),
      removedAt,
    };
    if (known.has(sameSettings(entry))) continue;
    known.add(sameSettings(entry));
    added.push(entry);
  }
  if (added.length) {
    try {
      writeFileAtomic(file, `${JSON.stringify([...kept, ...added], null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      console.warn(`[removed-dog-settings] could not save ${REMOVED_DOG_SETTINGS_FILE}; kept the old send and app settings on the dogs for now: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  for (const bot of holding) {
    delete bot.outbound;
    delete bot.connectorScopes;
  }
  return true;
}
