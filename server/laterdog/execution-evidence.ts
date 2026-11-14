import { z } from "zod";
import type { RuntimeEvent } from "../contracts.ts";
import { EFFORT_LEVELS, type ModelSelection } from "../../shared/wire.ts";

export interface ExecutionEvidence {
  turnId?: string;
  selected: ModelSelection;
  dispatched: ModelSelection;
  reportedModel?: string;
  providerInstanceId: string;
  attribution: "provider" | "dispatch" | "conflict";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  providerSucceeded: boolean;
  verification: "unverified";
}

const selectionSchema = z.object({
  instanceId: z.string(), model: z.string(),
  effort: z.enum(EFFORT_LEVELS).optional().catch(undefined),
  variant: z.string().optional().catch(undefined),
  fast: z.boolean().optional().catch(undefined),
});
export const executionEvidenceSchema = z.object({
  turnId: z.string().optional(), selected: selectionSchema, dispatched: selectionSchema,
  reportedModel: z.string().optional(), providerInstanceId: z.string(),
  attribution: z.enum(["provider", "dispatch", "conflict"]),
  startedAt: z.string().datetime(), completedAt: z.string().datetime(),
  durationMs: z.number().finite().nonnegative(), providerSucceeded: z.boolean(),
  verification: z.literal("unverified"),
});

export function parseExecutionEvidence(value: unknown): ExecutionEvidence | undefined {
  const parsed = executionEvidenceSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const whole = (selection: z.infer<typeof selectionSchema>): ModelSelection => ({
    instanceId: selection.instanceId, model: selection.model,
    ...(selection.effort !== undefined ? { effort: selection.effort } : {}),
    ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
    ...(selection.fast !== undefined ? { fast: selection.fast } : {}),
  });
  const { selected, dispatched, ...rest } = parsed.data;
  const evidence: ExecutionEvidence = { ...rest, selected: whole(selected), dispatched: whole(dispatched) };
  for (const key of Object.keys(evidence) as Array<keyof ExecutionEvidence>) if (evidence[key] === undefined) delete evidence[key];
  return evidence;
}

type Pending = Omit<ExecutionEvidence, "completedAt" | "durationMs" | "providerSucceeded" | "verification">;

export class ExecutionEvidenceTracker {
  private readonly pending = new Map<string, Pending>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  dispatch(threadId: string, selected: ModelSelection, dispatched: ModelSelection): void {
    this.pending.set(threadId, {
      selected: { ...selected }, dispatched: { ...dispatched },
      providerInstanceId: dispatched.instanceId, attribution: "dispatch",
      startedAt: new Date(this.now()).toISOString(),
    });
  }

  observe(event: RuntimeEvent): void {
    const pending = this.pending.get(event.threadId);
    if (!pending) return;
    if (event.turnId && pending.turnId && event.turnId !== pending.turnId) return;
    if (event.type === "turn.started") pending.turnId = event.turnId;
    if (event.providerInstanceId) {
      if (event.providerInstanceId !== pending.dispatched.instanceId) pending.attribution = "conflict";
      pending.providerInstanceId = event.providerInstanceId;
    }
    if (event.type === "session.started" && event.model) {
      pending.reportedModel = event.model;
      if (pending.attribution !== "conflict") pending.attribution = "provider";
    }
  }

  complete(event: Extract<RuntimeEvent, { type: "turn.completed" }>): ExecutionEvidence | undefined {
    const pending = this.pending.get(event.threadId);
    if (!pending || (event.turnId && pending.turnId && event.turnId !== pending.turnId)) return;
    this.pending.delete(event.threadId);
    return {
      ...pending, ...(event.turnId ? { turnId: event.turnId } : {}),
      completedAt: new Date(this.now()).toISOString(),
      durationMs: Math.max(0, this.now() - Date.parse(pending.startedAt)),
      providerSucceeded: event.ok, verification: "unverified",
    };
  }

  cancel(threadId: string): void { this.pending.delete(threadId); }

  ran(threadId: string): { on: string; model: string } | undefined {
    const pending = this.pending.get(threadId);
    return pending ? { on: pending.providerInstanceId, model: pending.reportedModel ?? pending.dispatched.model } : undefined;
  }

  running(): Array<[threadId: string, ran: { on: string; model: string }]> {
    return [...this.pending].map(([threadId, pending]) => [threadId, { on: pending.providerInstanceId, model: pending.reportedModel ?? pending.dispatched.model }]);
  }
}
