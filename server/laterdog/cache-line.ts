import type { UsageRow } from "../usage-ledger.ts";

export type CacheLineRow = Pick<UsageRow, "threadId" | "instanceId" | "input" | "cachedInput" | "cachedWrite">;

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

export function cacheLine(row: CacheLineRow): string | null {
  if (typeof row.cachedInput !== "number" && typeof row.cachedWrite !== "number") return null;
  const input = count(row.input);
  if (input === 0) return null;
  const cached = Math.min(count(row.cachedInput), input);
  const written = count(row.cachedWrite);
  return `[cache] chat=${row.threadId} account=${row.instanceId} input=${input} cached=${cached} written=${written}`;
}
