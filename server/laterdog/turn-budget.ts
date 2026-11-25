export const HELPER_TURN_TOOL_CALLS = 80;
export const HELPER_TURN_CONTEXT_TOKENS = 160_000;
export const TELL_AGAIN_EVERY_CALLS = 10;

export interface HelperTurnBounds {
  calls: number;
  tokens: number;
  every: number;
}

export function partlyDoneNotice(calls: number, contextTokens: number | undefined): string {
  const size = contextTokens ? ` and carries about ${Math.round(contextTokens / 1000)}K tokens of context` : "";
  return `later.dog: this helper turn has made ${calls} tool calls${size}. Finish the step you are on, save your current plan and workspace notes, then end this turn with a partly done report: what is finished, what is left and where things are. Keep unfinished plan items open. later.dog continues this request from that plan automatically; no new request is needed.`;
}

export class HelperTurnBudget {
  readonly #turns = new Map<string, { calls: number; told: number }>();
  readonly #bounds: HelperTurnBounds;

  constructor(bounds: Partial<HelperTurnBounds> = {}) {
    this.#bounds = { calls: HELPER_TURN_TOOL_CALLS, tokens: HELPER_TURN_CONTEXT_TOKENS, every: TELL_AGAIN_EVERY_CALLS, ...bounds };
  }

  begin(threadId: string): void {
    this.#turns.set(threadId, { calls: 0, told: 0 });
  }

  end(threadId: string): void {
    this.#turns.delete(threadId);
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

  fromHook(threadId: string, body: unknown, contextTokens?: number): { hookEventName: "PostToolUse"; additionalContext: string } | null {
    const event = body && typeof body === "object" ? (body as { event?: unknown }).event : undefined;
    if (event !== "PostToolUse") return null;
    const notice = this.toolUsed(threadId, contextTokens);
    return notice ? { hookEventName: "PostToolUse", additionalContext: notice } : null;
  }
}
