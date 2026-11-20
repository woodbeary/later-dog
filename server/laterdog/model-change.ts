import { sameModelId } from "../../shared/model-names.ts";

export { baseModelId, modelName, sameModelId } from "../../shared/model-names.ts";

export type ModelChangeCause = "safeguards" | "unavailable";

export interface ModelChange {
  from: string;
  to: string;
  cause: ModelChangeCause;
  scope?: string;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]{0,119}$/;

export function claudeModelChange(frame: Record<string, unknown>): ModelChange | undefined {
  const from = frame.original_model;
  const to = frame.fallback_model;
  if (typeof from !== "string" || typeof to !== "string" || !MODEL_ID.test(from) || !MODEL_ID.test(to) || sameModelId(from, to)) return undefined;
  const scope = typeof frame.scope === "string" && /^[a-z_]{1,24}$/.test(frame.scope) ? frame.scope : undefined;
  return { from, to, cause: frame.trigger === "refusal" ? "safeguards" : "unavailable", ...(scope ? { scope } : {}) };
}

export function modelChangeNotice(input: { from: string; to: string; cause: ModelChangeCause }): string {
  const { from, to, cause } = input;
  if (cause === "safeguards") return `${from}'s safeguards stopped a reply in this chat, so ${to} is answering for the rest of it.`;
  return `${to} is answering in this chat — ${from} isn't available for it right now.`;
}

export function modelBackNotice(model: string): string {
  return `${model} is answering again.`;
}

interface Changed {
  from: string;
  to: string;
}

export class ModelChanges {
  private readonly changed = new Map<string, Changed>();
  private readonly limit: number;

  constructor(limit = 2_000) {
    this.limit = limit;
  }

  noted(threadId: string, change: Changed): boolean {
    const known = this.changed.get(threadId);
    if (known && sameModelId(known.from, change.from) && sameModelId(known.to, change.to)) return false;
    this.changed.delete(threadId);
    this.changed.set(threadId, change);
    if (this.changed.size > this.limit) this.changed.delete(this.changed.keys().next().value!);
    return true;
  }

  started(threadId: string, dispatched: string, reported: string | null | undefined): { kind: "changed"; from: string; to: string } | { kind: "back"; model: string } | undefined {
    if (!reported || !MODEL_ID.test(reported)) return undefined;
    const known = this.changed.get(threadId);
    if (sameModelId(dispatched, reported)) {
      if (!known) return undefined;
      this.changed.delete(threadId);
      return { kind: "back", model: dispatched };
    }
    return this.noted(threadId, { from: dispatched, to: reported }) ? { kind: "changed", from: dispatched, to: reported } : undefined;
  }
}
