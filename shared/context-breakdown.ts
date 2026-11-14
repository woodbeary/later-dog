export const CONTEXT_PART_IDS = ["conversation", "tools", "instructions", "skills", "memory", "helpers", "other", "reserve", "free"] as const;

export type ContextPartId = typeof CONTEXT_PART_IDS[number];

export type ContextSource = "engine" | "estimate";

export interface ContextPart {
  id: ContextPartId;
  tokens: number;
  deferred?: true;
}

export interface ContextBreakdown {
  at: number;
  source: ContextSource;
  total: number;
  window: number;
  parts: ContextPart[];
  compactsAt?: number;
  stale?: true;
}

export const FOLD_BELOW_PERCENT = 0.5;
export const SAME_TOTAL_SHARE = 0.02;

export function differsFrom(tokens: number, current: number): boolean {
  if (current <= 0) return tokens > 0;
  return Math.abs(tokens - current) / current > SAME_TOTAL_SHARE;
}

export function breakdownIsStale(breakdown: ContextBreakdown, currentTokens: number | undefined): boolean {
  if (breakdown.stale) return true;
  return currentTokens !== undefined && currentTokens > 0 && differsFrom(breakdown.total, currentTokens);
}

export const ROOM_PARTS: ReadonlySet<ContextPartId> = new Set(["reserve", "free"]);

const PART_IDS: ReadonlySet<string> = new Set(CONTEXT_PART_IDS);

const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function contextBreakdownOf(raw: unknown): ContextBreakdown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!count(value.at) || (value.source !== "engine" && value.source !== "estimate") || !count(value.total) || !count(value.window) || value.window <= 0) return null;
  if (!Array.isArray(value.parts)) return null;
  const parts: ContextPart[] = [];
  for (const entry of value.parts as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const part = entry as Record<string, unknown>;
    if (typeof part.id !== "string" || !PART_IDS.has(part.id) || !count(part.tokens)) return null;
    parts.push({ id: part.id as ContextPartId, tokens: Math.round(part.tokens), ...(part.deferred === true ? { deferred: true as const } : {}) });
  }
  return {
    at: value.at,
    source: value.source,
    total: Math.round(value.total),
    window: Math.round(value.window),
    parts,
    ...(count(value.compactsAt) && value.compactsAt > 0 ? { compactsAt: Math.round(value.compactsAt) } : {}),
    ...(value.stale === true ? { stale: true as const } : {}),
  };
}

export interface ContextRow {
  id: ContextPartId;
  tokens: number;
  percent: number;
}

export interface ContextRows {
  used: ContextRow[];
  room: ContextRow[];
  notLoaded: number;
  usedTokens: number;
}

export function contextRows(breakdown: ContextBreakdown): ContextRows {
  const sums = new Map<ContextPartId, number>();
  let notLoaded = 0;
  for (const part of breakdown.parts) {
    if (part.deferred) notLoaded += part.tokens;
    else sums.set(part.id, (sums.get(part.id) ?? 0) + part.tokens);
  }
  const usedTokens = [...sums].reduce((sum, [id, tokens]) => (ROOM_PARTS.has(id) ? sum : sum + tokens), 0);
  const base = Math.max(breakdown.window, breakdown.total, usedTokens);
  const percent = (tokens: number) => (tokens / base) * 100;
  let folded = sums.get("other") ?? 0;
  const used: ContextRow[] = [];
  for (const [id, tokens] of sums) {
    if (ROOM_PARTS.has(id) || id === "other" || tokens <= 0) continue;
    if (percent(tokens) < FOLD_BELOW_PERCENT) folded += tokens;
    else used.push({ id, tokens, percent: percent(tokens) });
  }
  used.sort((a, b) => b.tokens - a.tokens);
  if (folded > 0) used.push({ id: "other", tokens: folded, percent: percent(folded) });
  const room = (["reserve", "free"] as const)
    .map((id) => ({ id, tokens: sums.get(id) ?? 0 }))
    .filter((row) => row.tokens > 0)
    .map((row) => ({ ...row, percent: percent(row.tokens) }));
  return { used, room, notLoaded, usedTokens };
}
