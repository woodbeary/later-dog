import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";


export interface TripwireHit {
  call: string;
  path: string;
  stack: string;
}

export const SYNC_CALLS_ALLOWED: ReadonlyArray<{ frame: string; reason: string }> = [
  { frame: "dogTricks", reason: "its synchronous branch runs only when dog folders are not mounted, on a desktop where they are local" },
];

const NO_PATH = new Set(["closeSync", "fstatSync", "readSync", "writeSync", "fsyncSync", "fdatasyncSync", "ftruncateSync", "futimesSync",
  "fchmodSync", "fchownSync", "readvSync", "writevSync"]);
const TWO_PATHS = new Set(["renameSync", "copyFileSync", "symlinkSync", "linkSync", "cpSync"]);

const pathOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
};

let mounted: (path: string) => boolean = () => false;

export function watchMountedPaths(test: (path: string) => boolean): void {
  mounted = test;
}

let armed = false;
let report: (hit: TripwireHit) => void = () => {};

export function onMountedSyncCall(listener: (hit: TripwireHit) => void): (hit: TripwireHit) => void {
  const previous = report;
  report = listener;
  return previous;
}

export function armSyncTripwire(): void {
  if (armed || !isMainThread) return;
  armed = true;
  const table = fs as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(table)) {
    if (!name.endsWith("Sync") || NO_PATH.has(name) || typeof value !== "function") continue;
    const original = value as (...args: unknown[]) => unknown;
    const watched = function (this: unknown, ...args: unknown[]) {
      if (armed) {
        for (const candidate of TWO_PATHS.has(name) ? args.slice(0, 2) : args.slice(0, 1)) {
          const path = pathOf(candidate);
          if (path === null || !mounted(resolve(path))) continue;
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = 60;
          const stack = new Error().stack ?? "";
          Error.stackTraceLimit = limit;
          if (!SYNC_CALLS_ALLOWED.some((allowed) => stack.includes(`at ${allowed.frame} `))) report({ call: name, path, stack });
          break;
        }
      }
      return original.apply(this, args);
    };
    Object.defineProperties(watched, Object.getOwnPropertyDescriptors(original));
    table[name] = watched;
  }
  syncBuiltinESMExports();
}
