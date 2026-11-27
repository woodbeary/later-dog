export type TurnShapeStart = { replyFirst: boolean; handOff: boolean; questions?: boolean };

export type PreToolDenial = { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };

export const REPLY_FIRST_HELD =
  "Not run yet: the person has not heard from you in this turn. Send them one short line now, the answer or what you are doing, then call this tool again.";

export const HAND_OFF_NOW =
  "Not run: this would be your third round of tool calls in a turn the person started. Hand the rest to a background helper now (the Agent tool with run_in_background true) with a complete brief, tell the person in one line that you started, and end your turn.";

export const HELPER_IN_BACKGROUND =
  "Not run: start the helper with run_in_background true, so you stay free to answer the person, then tell them in one line that you started and end your turn.";

export const DECIDE_YOURSELF =
  "Not asked: decide this yourself, do it, and tell the person in one line what you chose. A question card is only for setting up a new dog.";

export const TURN_SHAPE_ROUNDS = 2;

const QUESTION_TOOLS = /(?:^|__)(?:AskUserQuestion|request_user_input)$/;

const HELPER_TOOLS = new Set(["Agent", "Task"]);
const OPENING_TOOLS = /(?:^|__)react$/;
const FREE_TOOLS = /(?:^|__)(?:react|AskUserQuestion|TodoWrite|set_plan|coordinate_bots|start_tasks|start_swarm|list_bots|memory_update|memory_log|request_[a-z_]+|propose_[a-z_]+)$/;

type Turn = TurnShapeStart & { replied: boolean; rounds: number; resultSince: boolean; handedOff: boolean; held: number };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function fromHelper(payload: Record<string, unknown>): boolean {
  return typeof payload.agent_id === "string" && payload.agent_id.length > 0;
}

function deny(reason: string): PreToolDenial {
  return { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason };
}

export class TurnShape {
  readonly #turns = new Map<string, Turn>();

  begin(threadId: string, start: TurnShapeStart): void {
    if (!start.replyFirst && !start.handOff && start.questions !== false) {
      this.#turns.delete(threadId);
      return;
    }
    this.#turns.set(threadId, { ...start, replied: false, rounds: 0, resultSince: false, handedOff: false, held: 0 });
  }

  end(threadId: string): void {
    this.#turns.delete(threadId);
  }

  replied(threadId: string): void {
    const turn = this.#turns.get(threadId);
    if (turn) turn.replied = true;
  }

  facts(threadId: string): { replied: boolean; rounds: number; handedOff: boolean; held: number } | null {
    const turn = this.#turns.get(threadId);
    return turn ? { replied: turn.replied, rounds: turn.rounds, handedOff: turn.handedOff, held: turn.held } : null;
  }

  awaitsReply(threadId: string, body: unknown): boolean {
    const turn = this.#turns.get(threadId);
    if (!turn || !turn.replyFirst || turn.replied) return false;
    const payload = record(record(body).payload ?? body);
    return !fromHelper(payload) && !OPENING_TOOLS.test(typeof payload.tool_name === "string" ? payload.tool_name : "");
  }

  beforeTool(threadId: string, body: unknown): PreToolDenial | null {
    const turn = this.#turns.get(threadId);
    if (!turn) return null;
    const payload = record(record(body).payload ?? body);
    if (fromHelper(payload)) return null;
    const name = typeof payload.tool_name === "string" ? payload.tool_name : "";
    const input = record(payload.tool_input);
    if (turn.questions === false && QUESTION_TOOLS.test(name)) {
      turn.held += 1;
      return deny(DECIDE_YOURSELF);
    }
    if (turn.replyFirst && !turn.replied && !OPENING_TOOLS.test(name)) {
      turn.held += 1;
      return deny(REPLY_FIRST_HELD);
    }
    if (HELPER_TOOLS.has(name)) {
      if (turn.handOff && !turn.handedOff && input.run_in_background !== true) {
        turn.held += 1;
        return deny(HELPER_IN_BACKGROUND);
      }
      turn.handedOff = true;
      return null;
    }
    if (FREE_TOOLS.test(name) || (name === "Bash" && input.run_in_background === true)) return null;
    if (!turn.handOff || turn.handedOff) return null;
    if (turn.rounds === 0 || turn.resultSince) {
      turn.rounds += 1;
      turn.resultSince = false;
    }
    if (turn.rounds <= TURN_SHAPE_ROUNDS) return null;
    turn.held += 1;
    return deny(HAND_OFF_NOW);
  }

  afterTool(threadId: string, body: unknown): void {
    const turn = this.#turns.get(threadId);
    if (!turn) return;
    const payload = record(record(body).payload ?? body);
    if (!fromHelper(payload)) turn.resultSince = true;
  }
}
