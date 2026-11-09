import { createHash } from "node:crypto";

import { callKey } from "../repeat-detector.ts";

const MAX_DEPTH = 8;
const MAX_NODES = 2000;

class Unknown extends Error {}

function canonical(value: unknown, depth: number, budget: { nodes: number }): unknown {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES) throw new Unknown();
  if (value === null) return ["null"];
  if (typeof value === "string") return ["s", value];
  if (typeof value === "boolean") return ["b", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Unknown();
    return ["n", value];
  }
  if (Array.isArray(value)) return ["a", value.map((item) => canonical(item, depth + 1, budget))];
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["o", Object.keys(record).sort().map((key) => [key, canonical(record[key], depth + 1, budget)])];
  }
  throw new Unknown();
}

export function toolArgsDigest(args: unknown): string | undefined {
  if (args === undefined) return undefined;
  try {
    const text = JSON.stringify(canonical(args, 0, { nodes: 0 }));
    return createHash("sha256").update(text).digest("hex").slice(0, 16);
  } catch (error) {
    if (error instanceof Unknown) return undefined;
    throw error;
  }
}

export function permissionCallKey(event: { tool: string; summary: string; argsDigest?: string; argsUnknown?: true }): string | null {
  return event.argsUnknown ? null : callKey(event.tool, event.summary, event.argsDigest);
}
