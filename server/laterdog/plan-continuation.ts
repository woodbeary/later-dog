import { createHash } from "node:crypto";
import type { PlanItem } from "../../shared/dog-plan.ts";
import { fileListLedger, type ListLedger } from "./list-ledger.ts";

export const NO_PROGRESS_CONTINUES = 3;
export const MAX_PLAN_CONTINUES = 20;

const LIMIT_REASON = /^(?:error_)?(?:max_turns|max_tokens|max_output_tokens|tool_limit|tool_call_limit|context_limit|context_length_exceeded|model_context_window_exceeded|turn_limit|length)$/i;
const LIMIT_WORDS = /^(?:stopped after \d+ [a-z ]+ without a final answer|model-call limit reached)|(?:prompt|input) is too long|(?:maximum|max) (?:number of )?(?:tool calls|turns|tokens) (?:reached|exceeded)|(?:context (?:window|length)|maximum context length).{0,40}(?:exceed|limit)|exceeds?.{0,30}(?:context window|context length)/i;

export function endedAtTurnLimit(reason: string | null | undefined, failure?: string): boolean {
  if (/usage_limit|auth_required|provider_safety|interrupted|cancelled|update_required/i.test(reason ?? "")) return false;
  return LIMIT_REASON.test(reason ?? "") || LIMIT_WORDS.test(reason ?? "") || LIMIT_WORDS.test(failure ?? "");
}

export function planProgress(items: readonly PlanItem[]): string {
  return createHash("sha256").update(JSON.stringify(items.filter(item => item.status === "done").map(item => item.text).sort())).digest("hex");
}

export interface PlanContinuation {
  botId: string;
  threadId: string;
  sourceId: string;
  generation: string;
  progress: string;
  attempts: number;
  stalled: number;
  pending: boolean;
  turnId?: string;
  coordinationId?: string;
  groupId?: string;
  recover?: boolean;
  announced?: boolean;
}

const isEntry = (value: unknown): value is PlanContinuation => {
  const row = value as Partial<PlanContinuation> | null;
  return Boolean(row && [row.botId, row.threadId, row.sourceId, row.generation, row.progress].every(field => typeof field === "string" && field.length > 0)
    && Number.isInteger(row.attempts) && row.attempts! >= 0 && Number.isInteger(row.stalled) && row.stalled! >= 0 && typeof row.pending === "boolean");
};

export const filePlanContinuations = (path: string): ListLedger<PlanContinuation> => fileListLedger(path, isEntry);

export interface PlanContinuationHost {
  state(entry: PlanContinuation): "ready" | "wait" | "cancel";
  start(entry: PlanContinuation, prompt: string): Promise<unknown>;
  blocked(error: unknown): boolean;
  notice(entry: PlanContinuation, text: string, ok: boolean): void;
  changed(threadId: string): void;
  failed?(entry: PlanContinuation, text: string): void;
}

export const planContinuationPrompt = "[later.dog continuation: the previous turn reached its size, context or tool limit while your plan was unfinished. Continue from the first unfinished step in your saved plan and workspace notes. Read the current state before repeating commands or external actions; completed work remains in place. Keep the plan current, finish the authorized request and verify the result. This is a system continuation of the same request, not a new instruction from the person.]";

export class PlanContinuations {
  private readonly entries = new Map<string, PlanContinuation>();
  private readonly starting = new Set<string>();
  private readonly ledger: ListLedger<PlanContinuation>;
  private readonly host: PlanContinuationHost;

  constructor(ledger: ListLedger<PlanContinuation>, host: PlanContinuationHost) {
    this.ledger = ledger;
    this.host = host;
    for (const entry of ledger.read()) this.entries.set(entry.threadId, { ...entry, pending: entry.pending || entry.recover === true });
  }

  get(threadId: string): PlanContinuation | undefined {
    const entry = this.entries.get(threadId);
    return entry ? { ...entry } : undefined;
  }

  pending(threadId: string): boolean {
    return this.entries.get(threadId)?.pending === true;
  }

  begin(input: Pick<PlanContinuation, "botId" | "threadId" | "sourceId" | "generation" | "coordinationId" | "groupId">, items: readonly PlanItem[]): void {
    const before = this.entries.get(input.threadId);
    this.entries.set(input.threadId, { ...input, progress: planProgress(items), attempts: 0, stalled: 0,
      ...(before?.sourceId === input.sourceId && before.botId === input.botId ? { progress: before.progress, attempts: before.attempts, stalled: before.stalled,
        ...(before.pending || before.recover ? { recover: true } : {}) } : {}), pending: false });
    this.save();
  }

  end(input: { threadId: string; turnId?: string; generation: string; reason?: string | null; failure?: string; items: readonly PlanItem[]; eligible: boolean }): boolean {
    const entry = this.entries.get(input.threadId);
    if (!entry || entry.generation !== input.generation || (input.turnId && entry.turnId === input.turnId)) return false;
    if (!input.eligible || !input.items.some(item => item.status !== "done") || !endedAtTurnLimit(input.reason, input.failure)) {
      this.cancel(input.threadId);
      return false;
    }
    const progress = planProgress(input.items);
    const stalled = entry.attempts > 0 && entry.progress === progress ? entry.stalled + 1 : 0;
    if (stalled >= NO_PROGRESS_CONTINUES || entry.attempts >= MAX_PLAN_CONTINUES) {
      const why = stalled >= NO_PROGRESS_CONTINUES ? `${NO_PROGRESS_CONTINUES} continuation turns finished without completing another plan step` : `${MAX_PLAN_CONTINUES} continuation turns were used`;
      this.cancel(input.threadId);
      this.host.notice(entry, `Automatic continuation stopped because ${why}. The unfinished plan and notes are saved.`, false);
      return false;
    }
    this.entries.set(input.threadId, { ...entry, progress, stalled, attempts: entry.attempts + 1, pending: true, recover: true, announced: false, turnId: input.turnId });
    this.save();
    this.host.changed(input.threadId);
    return true;
  }

  cancel(threadId: string): void {
    if (!this.entries.delete(threadId)) return;
    this.save();
    this.host.changed(threadId);
  }

  drain(): void {
    for (const entry of this.entries.values()) {
      if (!entry.pending || this.starting.has(entry.threadId)) continue;
      const state = this.host.state(entry);
      if (state === "cancel") { this.cancel(entry.threadId); continue; }
      if (state === "wait") continue;
      this.starting.add(entry.threadId);
      if (!entry.announced) {
        entry.announced = true;
        this.save();
        this.host.notice(entry, "The turn reached its limit. Continuing from the saved plan and notes.", true);
      }
      void this.host.start({ ...entry }, planContinuationPrompt).then(() => {
        const current = this.entries.get(entry.threadId);
        if (current?.generation === entry.generation) {
          current.pending = false;
          this.save();
          this.host.changed(entry.threadId);
        }
      }, (error: unknown) => {
        const current = this.entries.get(entry.threadId);
        if (current?.generation !== entry.generation || this.host.blocked(error)) return;
        const text = `Automatic continuation could not start: ${error instanceof Error ? error.message : String(error)}. The unfinished plan and notes are saved.`;
        this.cancel(entry.threadId);
        this.host.notice(entry, text, false);
        this.host.failed?.(entry, text);
      }).finally(() => this.starting.delete(entry.threadId));
    }
  }

  private save(): void {
    this.ledger.write([...this.entries.values()]);
  }
}
