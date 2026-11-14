import { readFileSync } from "node:fs";

import { breakdownIsStale, contextBreakdownOf, type ContextBreakdown } from "../../shared/context-breakdown.ts";
import { writeFileAtomic } from "../atomic.ts";
import { breakdownFromEngine, estimatedBreakdown, estimateSizesOf, type EstimateSizes } from "./context-parts.ts";
import type { EngineContextReply } from "./engine-context-ask.ts";

export const CONTEXT_BREAKDOWNS_KEPT = 500;
export const ENGINE_COUNTING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

export interface ContextEngine {
  contextUsage?(threadId: string): Promise<EngineContextReply>;
}

interface ChatRecord {
  driverKind: string;
  instanceId: string;
  sizes?: EstimateSizes;
  counted?: ContextBreakdown;
  turnEndedAt?: number;
}

export interface ChatContextBreakdownsDeps {
  file: string;
  engine(instanceId: string): ContextEngine | undefined;
  now?: () => number;
}

const SIZE_KEYS = ["instructions", "memory", "skills", "tools", "toolsNotLoaded"] as const;

function sizesOf(raw: unknown): EstimateSizes | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (!SIZE_KEYS.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0)) return undefined;
  return Object.fromEntries(SIZE_KEYS.map((key) => [key, value[key] as number])) as unknown as EstimateSizes;
}

function recordOf(raw: unknown): ChatRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.driverKind !== "string" || typeof value.instanceId !== "string") return null;
  const sizes = sizesOf(value.sizes);
  const counted = contextBreakdownOf(value.counted);
  const turnEndedAt = typeof value.turnEndedAt === "number" && Number.isFinite(value.turnEndedAt) ? value.turnEndedAt : undefined;
  return {
    driverKind: value.driverKind,
    instanceId: value.instanceId,
    ...(sizes ? { sizes } : {}),
    ...(counted?.source === "engine" ? { counted } : {}),
    ...(turnEndedAt !== undefined ? { turnEndedAt } : {}),
  };
}

export function markedStale(counted: ContextBreakdown, turnEndedAt: number | undefined, currentTokens: number | undefined): ContextBreakdown {
  const fresh: ContextBreakdown = { ...counted };
  delete fresh.stale;
  const older = turnEndedAt !== undefined && counted.at < turnEndedAt;
  return older || breakdownIsStale(fresh, currentTokens) ? { ...fresh, stale: true } : fresh;
}

export class ChatContextBreakdowns {
  private readonly chats = new Map<string, ChatRecord>();
  private readonly now: () => number;
  private readonly deps: ChatContextBreakdownsDeps;

  constructor(deps: ChatContextBreakdownsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    try {
      const saved: unknown = JSON.parse(readFileSync(deps.file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        for (const [threadId, raw] of Object.entries(saved)) {
          const record = recordOf(raw);
          if (record) this.chats.set(threadId, record);
        }
      }
    } catch {}
  }

  dispatched(threadId: string, turn: { driverKind: string; instanceId: string; sections: ReadonlyArray<{ id: string; bytes: number }>; tools: { loadedBytes: number; notLoadedBytes: number } | null }): void {
    const before = this.chats.get(threadId);
    const sameEngine = before?.instanceId === turn.instanceId && before.driverKind === turn.driverKind;
    this.chats.delete(threadId);
    this.chats.set(threadId, {
      driverKind: turn.driverKind,
      instanceId: turn.instanceId,
      sizes: estimateSizesOf(turn.sections, turn.tools),
      ...(sameEngine && before?.counted ? { counted: before.counted } : {}),
      ...(sameEngine && before?.turnEndedAt !== undefined ? { turnEndedAt: before.turnEndedAt } : {}),
    });
    this.save();
  }

  async afterTurn(threadId: string): Promise<ContextBreakdown | null> {
    const record = this.chats.get(threadId);
    if (record) {
      record.turnEndedAt = this.now();
      this.save();
    }
    return this.ask(threadId);
  }

  async read(threadId: string, measured: { tokens?: number; window?: number } | undefined): Promise<ContextBreakdown | null> {
    const record = this.chats.get(threadId);
    if (!record) return null;
    if (ENGINE_COUNTING_DRIVERS.has(record.driverKind)) {
      await this.ask(threadId);
      const current = this.chats.get(threadId);
      return current?.counted ? markedStale(current.counted, current.turnEndedAt, measured?.tokens) : null;
    }
    return record.sizes ? estimatedBreakdown(record.sizes, measured ?? {}, this.now()) : null;
  }

  forget(threadIds: readonly string[]): void {
    let changed = false;
    for (const threadId of threadIds) changed = this.chats.delete(threadId) || changed;
    if (changed) this.save();
  }

  private async ask(threadId: string): Promise<ContextBreakdown | null> {
    const record = this.chats.get(threadId);
    if (!record || !ENGINE_COUNTING_DRIVERS.has(record.driverKind)) return null;
    const engine = this.deps.engine(record.instanceId);
    if (!engine?.contextUsage) return record.counted ?? null;
    const reply = await engine.contextUsage(threadId).catch((): EngineContextReply => ({ kind: "none" }));
    if (reply.kind !== "answer") return record.counted ?? null;
    const counted = breakdownFromEngine(reply.answer, this.now());
    const current = this.chats.get(threadId);
    if (!counted || !current || current.instanceId !== record.instanceId) return current?.counted ?? null;
    current.counted = counted;
    this.save();
    return counted;
  }

  private save(): void {
    while (this.chats.size > CONTEXT_BREAKDOWNS_KEPT) this.chats.delete(this.chats.keys().next().value!);
    try {
      writeFileAtomic(this.deps.file, JSON.stringify(Object.fromEntries(this.chats)), { mode: 0o600, durable: false });
    } catch {}
  }
}
