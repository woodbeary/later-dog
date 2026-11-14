import type { ContextBreakdown, ContextPart, ContextPartId } from "../../shared/context-breakdown.ts";

export const ENGINE_CATEGORY_PARTS: Readonly<Record<string, ContextPartId>> = {
  messages: "conversation",
  system_tools: "tools",
  mcp_tools: "tools",
  system_prompt: "instructions",
  mcp_instructions: "instructions",
  skills: "skills",
  memory_files: "memory",
  custom_agents: "helpers",
  autocompact_buffer: "reserve",
  compact_buffer: "reserve",
  free_space: "free",
};

export const ENGINE_DEFERRED_CATEGORIES: ReadonlySet<string> = new Set(["mcp_tools_deferred", "system_tools_deferred"]);

const ENGINE_KIND_PARTS: Readonly<Record<string, ContextPartId>> = { free: "free", buffer: "reserve", used: "other" };

const ENGINE_NAME_PARTS: Readonly<Record<string, ContextPartId>> = {
  "messages": "conversation",
  "system tools": "tools",
  "mcp tools": "tools",
  "system prompt": "instructions",
  "mcp server instructions": "instructions",
  "skills": "skills",
  "memory files": "memory",
  "custom agents": "helpers",
  "autocompact buffer": "reserve",
  "compact buffer": "reserve",
  "free space": "free",
};

const PART_ORDER: readonly ContextPartId[] = ["conversation", "tools", "instructions", "skills", "memory", "helpers", "other", "reserve", "free"];

const size = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

type Placed = { id: ContextPartId; deferred: boolean };

export function engineCategoryPart(category: { id?: unknown; name?: unknown; kind?: unknown; isDeferred?: unknown }): Placed {
  const id = typeof category.id === "string" ? category.id : undefined;
  if (category.kind === "deferred" || category.isDeferred === true || (id !== undefined && ENGINE_DEFERRED_CATEGORIES.has(id))) return { id: "tools", deferred: true };
  if (id !== undefined && Object.hasOwn(ENGINE_CATEGORY_PARTS, id)) return { id: ENGINE_CATEGORY_PARTS[id]!, deferred: false };
  if (typeof category.kind === "string" && Object.hasOwn(ENGINE_KIND_PARTS, category.kind)) return { id: ENGINE_KIND_PARTS[category.kind]!, deferred: false };
  const name = typeof category.name === "string" ? category.name.trim().toLowerCase() : "";
  if (Object.hasOwn(ENGINE_NAME_PARTS, name)) return { id: ENGINE_NAME_PARTS[name]!, deferred: false };
  if (name.endsWith("(deferred)")) return { id: "tools", deferred: true };
  return { id: "other", deferred: false };
}

export function settledParts(used: Map<ContextPartId, number>, reserve: number, notLoaded: number, total: number, window: number): ContextPart[] {
  const counted = [...used.values()].reduce((sum, tokens) => sum + tokens, 0);
  if (counted < total) used.set("conversation", (used.get("conversation") ?? 0) + total - counted);
  let excess = counted - total;
  for (const id of PART_ORDER) {
    if (excess <= 0) break;
    const tokens = used.get(id) ?? 0;
    const take = Math.min(tokens, excess);
    used.set(id, tokens - take);
    excess -= take;
  }
  const reserveKept = Math.max(0, Math.min(reserve, window - total));
  const free = Math.max(0, window - total - reserveKept);
  const parts: ContextPart[] = PART_ORDER
    .filter((id) => id !== "reserve" && id !== "free")
    .map((id) => ({ id, tokens: used.get(id) ?? 0 }))
    .filter((part) => part.tokens > 0);
  if (reserveKept > 0) parts.push({ id: "reserve", tokens: reserveKept });
  if (free > 0) parts.push({ id: "free", tokens: free });
  if (notLoaded > 0) parts.push({ id: "tools", tokens: notLoaded, deferred: true });
  return parts;
}

export function breakdownFromEngine(raw: unknown, at: number): ContextBreakdown | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const answer = raw as Record<string, unknown>;
  const window = size(answer.maxTokens);
  if (!window || !Array.isArray(answer.categories)) return null;
  const used = new Map<ContextPartId, number>();
  let reserve = 0;
  let notLoaded = 0;
  for (const entry of answer.categories as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const tokens = size((entry as { tokens?: unknown }).tokens);
    if (tokens === null) continue;
    const placed = engineCategoryPart(entry as Record<string, unknown>);
    if (placed.deferred) notLoaded += tokens;
    else if (placed.id === "reserve") reserve += tokens;
    else if (placed.id !== "free") used.set(placed.id, (used.get(placed.id) ?? 0) + tokens);
  }
  const counted = [...used.values()].reduce((sum, tokens) => sum + tokens, 0);
  const total = size(answer.totalTokens) ?? counted;
  const threshold = size(answer.autoCompactThreshold);
  const compacts = answer.isAutoCompactEnabled !== false && threshold !== null && threshold > 0 && threshold <= window;
  return {
    at,
    source: "engine",
    total,
    window,
    parts: settledParts(used, reserve, notLoaded, total, window),
    ...(compacts ? { compactsAt: threshold } : {}),
  };
}

export const ESTIMATE_BYTES_PER_TOKEN = 4;

export interface EstimateSizes {
  instructions: number;
  memory: number;
  skills: number;
  tools: number;
  toolsNotLoaded: number;
}

const MEMORY_SECTIONS: ReadonlySet<string> = new Set(["memory"]);
const SKILL_SECTIONS: ReadonlySet<string> = new Set(["skills", "skill-instructions"]);

export function estimateSizesOf(sections: ReadonlyArray<{ id: string; bytes: number }>, tools: { loadedBytes: number; notLoadedBytes: number } | null): EstimateSizes {
  const bytes = { instructions: 0, memory: 0, skills: 0 };
  for (const section of sections) {
    if (!(section.bytes > 0)) continue;
    if (MEMORY_SECTIONS.has(section.id)) bytes.memory += section.bytes;
    else if (SKILL_SECTIONS.has(section.id)) bytes.skills += section.bytes;
    else bytes.instructions += section.bytes;
  }
  const tokens = (value: number) => Math.ceil(value / ESTIMATE_BYTES_PER_TOKEN);
  return {
    instructions: tokens(bytes.instructions),
    memory: tokens(bytes.memory),
    skills: tokens(bytes.skills),
    tools: tokens(tools?.loadedBytes ?? 0),
    toolsNotLoaded: tokens(tools?.notLoadedBytes ?? 0),
  };
}

export function estimatedBreakdown(sizes: EstimateSizes, measured: { tokens?: number; window?: number }, at: number): ContextBreakdown | null {
  const total = size(measured.tokens);
  const window = size(measured.window);
  if (!total || !window) return null;
  const known = new Map<ContextPartId, number>([["instructions", sizes.instructions], ["tools", sizes.tools], ["skills", sizes.skills], ["memory", sizes.memory]]);
  const knownTotal = [...known.values()].reduce((sum, tokens) => sum + tokens, 0);
  if (knownTotal > total) return { at, source: "estimate", total, window, parts: [] };
  known.set("conversation", total - knownTotal);
  return { at, source: "estimate", total, window, parts: settledParts(known, 0, sizes.toolsNotLoaded, total, window) };
}
