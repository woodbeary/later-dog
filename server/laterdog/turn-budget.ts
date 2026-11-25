import type { RuntimeEvent } from "../contracts.ts";

export const HELPER_TURN_TOOL_CALLS = 80;
export const HELPER_TURN_CONTEXT_TOKENS = 160_000;
export const TELL_AGAIN_EVERY_CALLS = 10;

export interface HelperTurnBounds {
  calls: number;
  tokens: number;
  every: number;
}

export function partlyDoneNotice(calls: number, contextTokens: number | undefined): string {
  const size = contextTokens
    ? ` and carries about ${Math.round(contextTokens / 1000)}K tokens of context`
    : "";
  return `later.dog: this helper turn has made ${calls} tool calls${size}. Finish the step you are on, then end your turn with a report that begins with partly done: what is finished, what is left and where things are, so the dog that asked can send the rest as a new request in a fresh turn.`;
}

export class HelperTurnBudget {
  readonly #turns = new Map<
    string,
    {
      calls: number;
      told: number;
      native?: { instanceId: string; turnId?: string; items: Set<string> };
    }
  >();
  readonly #bounds: HelperTurnBounds;

  constructor(bounds: Partial<HelperTurnBounds> = {}) {
    this.#bounds = {
      calls: HELPER_TURN_TOOL_CALLS,
      tokens: HELPER_TURN_CONTEXT_TOKENS,
      every: TELL_AGAIN_EVERY_CALLS,
      ...bounds,
    };
  }

  begin(threadId: string, nativeInstanceId?: string): void {
    this.#turns.set(threadId, {
      calls: 0,
      told: 0,
      ...(nativeInstanceId
        ? { native: { instanceId: nativeInstanceId, items: new Set<string>() } }
        : {}),
    });
  }

  end(threadId: string, event?: RuntimeEvent): void {
    const native = this.#turns.get(threadId)?.native;
    if (
      event &&
      native &&
      (event.synthetic ||
        event.provider !== "codex" ||
        event.providerInstanceId !== native.instanceId ||
        !event.turnId ||
        event.turnId !== native.turnId)
    )
      return;
    this.#turns.delete(threadId);
  }

  bindNative(threadId: string, instanceId: string, turnId: string): void {
    const native = this.#turns.get(threadId)?.native;
    if (native?.instanceId === instanceId && turnId) native.turnId ??= turnId;
  }

  fromNative(event: RuntimeEvent, contextTokens?: number): string | null {
    const native = this.#turns.get(event.threadId)?.native;
    if (
      !native ||
      event.synthetic ||
      event.provider !== "codex" ||
      event.providerInstanceId !== native.instanceId ||
      !event.turnId
    )
      return null;
    if (
      event.turnId !== native.turnId ||
      event.type !== "item.completed" ||
      event.itemType !== "tool" ||
      !event.itemId ||
      native.items.has(event.itemId)
    )
      return null;
    native.items.add(event.itemId);
    return this.toolUsed(event.threadId, contextTokens);
  }

  toolUsed(threadId: string, contextTokens?: number): string | null {
    const turn = this.#turns.get(threadId);
    if (!turn) return null;
    turn.calls += 1;
    const over = turn.calls >= this.#bounds.calls || (contextTokens ?? 0) >= this.#bounds.tokens;
    if (!over || (turn.told && turn.calls - turn.told < this.#bounds.every)) return null;
    turn.told = turn.calls;
    return partlyDoneNotice(turn.calls, contextTokens);
  }

  fromHook(
    threadId: string,
    body: unknown,
    contextTokens?: number,
  ): { hookEventName: "PostToolUse"; additionalContext: string } | null {
    const event =
      body && typeof body === "object" ? (body as { event?: unknown }).event : undefined;
    if (event !== "PostToolUse" || this.#turns.get(threadId)?.native) return null;
    const notice = this.toolUsed(threadId, contextTokens);
    return notice ? { hookEventName: "PostToolUse", additionalContext: notice } : null;
  }
}
