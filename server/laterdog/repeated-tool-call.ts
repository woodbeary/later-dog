import { createHash } from "node:crypto";

const MAX_DEPTH = 8;

function canonical(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "…";
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key], depth + 1);
    return out;
  }
  return value;
}

export function toolArgsDigest(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args === "object" && Object.keys(args).length === 0) return undefined;
  const text = JSON.stringify(canonical(args, 0));
  if (text === undefined) return undefined;
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
