import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type OwnedRead<T> =
  | { state: "absent" }
  | { state: "ok"; value: T }
  | { state: "damaged"; keptAs: string | null };

const DAMAGED_INFIX = ".damaged-";

export function damagedCopyName(file: string, at: Date): string {
  return `${basename(file)}${DAMAGED_INFIX}${at.toISOString().replace(/[:.]/g, "-")}`;
}

function existingCopy(file: string, bytes: Buffer): string | null {
  const prefix = `${basename(file)}${DAMAGED_INFIX}`;
  let names: string[];
  try {
    names = readdirSync(dirname(file)).filter((name) => name.startsWith(prefix)).sort();
  } catch {
    return null;
  }
  const latest = names.at(-1);
  if (!latest) return null;
  try {
    return readFileSync(join(dirname(file), latest)).equals(bytes) ? latest : null;
  } catch {
    return null;
  }
}

function keepCopy(file: string, bytes: Buffer, now: Date): string | null {
  const already = existingCopy(file, bytes);
  if (already) return already;
  const name = damagedCopyName(file, now);
  try {
    writeFileSync(join(dirname(file), name), bytes, { mode: 0o600, flag: "wx" });
    return name;
  } catch (error) {
    console.warn(`[owned-file] could not keep a copy of ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function readOwnedJson<T>(file: string, parse: (raw: unknown) => T | undefined, now: () => Date = () => new Date()): OwnedRead<T> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { state: "absent" };
    console.warn(`[owned-file] could not read ${basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
    return { state: "damaged", keptAs: null };
  }
  let value: T | undefined;
  try {
    value = parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    value = undefined;
  }
  if (value !== undefined) return { state: "ok", value };
  const keptAs = keepCopy(file, bytes, now());
  console.warn(`[owned-file] ${basename(file)} could not be read${keptAs ? `; kept a copy as ${keptAs}` : ""}`);
  return { state: "damaged", keptAs };
}
