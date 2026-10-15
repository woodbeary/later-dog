import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";

export type HeldPlace = "cloud";

const FILE_LIMIT = 64 * 1024;
const PLACES = new Set<HeldPlace>(["cloud"]);

export const HELD_ACCOUNT_REASON: Record<HeldPlace, string> = {
  cloud: "This account is on your later.dog Cloud now. This Mac does not use it.",
};

export function readHeldAccounts(file: string): Map<string, HeldPlace> {
  const held = new Map<string, HeldPlace>();
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > FILE_LIMIT) return held;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { held?: unknown };
    if (!parsed.held || typeof parsed.held !== "object" || Array.isArray(parsed.held)) return held;
    for (const [id, place] of Object.entries(parsed.held)) if (PLACES.has(place as HeldPlace)) held.set(id, place as HeldPlace);
  } catch {}
  return held;
}

export function heldAccountReason(file: string, instanceId: string): string | null {
  const place = readHeldAccounts(file).get(instanceId);
  return place ? HELD_ACCOUNT_REASON[place] : null;
}

export function setHeldAccount(file: string, instanceId: string, place: HeldPlace | null): void {
  const held = readHeldAccounts(file);
  if (place) held.set(instanceId, place);
  else held.delete(instanceId);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify({ version: 1, held: Object.fromEntries(held) }, null, 2)}\n`, { mode: 0o600 });
}
