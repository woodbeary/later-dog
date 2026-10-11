import type { Refusal } from "./auth";

export const CLEF_MODEL = "@cf/cloudflare/clef";
export const CLEF_SELECTOR = "clef";
export const DECIDE_MAX_BODY_BYTES = 64 * 1024;
export const DECIDE_MAX_STATE_BYTES = 24_000;
export const DECIDE_MAX_OPTIONS = 64;
export const DECIDE_MAX_OPTION_CHARS = 600;
export const DECISIONS_PER_DAY = 500;
export const DECISIONS_TOTAL_PER_DAY = 100_000;
export const VOICE_CHARS_TOTAL_PER_DAY = 400_000;

export type UsageKind = "decisions" | "voice_chars";

export const KEY_CHECK_STATE = { purpose: "later.dog is checking that a decision-model key works." };
export const KEY_CHECK_QUESTION = "Is this a connection check?";
export const ROOM_ROUTING_INSTRUCTIONS =
  "Which bot in this room should answer `new_message`? Choose __everyone__ only when the message needs several members to answer.";
const ROOM_STATE_KEYS = new Set(["room", "humans_in_room", "bots_in_room", "recent_messages", "new_message"]);
const ROOM_STATE_REQUIRED = ["room", "humans_in_room", "bots_in_room", "new_message"];

export type Decision =
  | { kind: "keyCheck"; state: unknown; questions: { answer: { type: "noul"; instructions: string } } }
  | { kind: "roomRouting"; state: Record<string, unknown>; questions: { answer: { type: "choice"; instructions: string; criteria: Record<string, string> } } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const refuse = (message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status: 422, code: "unsupported_decision", message } });

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function decisionFrom(body: unknown): { ok: true; decision: Decision } | { ok: false; refusal: Refusal } {
  if (!isRecord(body) || !isRecord(body.questions)) return refuse("Send a state and one question.");
  const ids = Object.keys(body.questions);
  const question = body.questions.answer;
  if (ids.length !== 1 || !isRecord(question)) return refuse("This service answers one question, named answer.");
  if (question.type === "noul") {
    if (question.instructions !== KEY_CHECK_QUESTION || question.criteria !== undefined || JSON.stringify(body.state) !== JSON.stringify(KEY_CHECK_STATE)) {
      return refuse("This service only answers later.dog's own questions.");
    }
    return { ok: true, decision: { kind: "keyCheck", state: KEY_CHECK_STATE, questions: { answer: { type: "noul", instructions: KEY_CHECK_QUESTION } } } };
  }
  if (question.type !== "choice" || question.instructions !== ROOM_ROUTING_INSTRUCTIONS || !isRecord(question.criteria)) {
    return refuse("This service only answers later.dog's own questions.");
  }
  const options = Object.entries(question.criteria);
  if (options.length < 2 || options.length > DECIDE_MAX_OPTIONS) return refuse(`A choice needs 2 to ${DECIDE_MAX_OPTIONS} options.`);
  if (!options.every(([key, text]) => key.length > 0 && key.length <= 100 && typeof text === "string" && text.length <= DECIDE_MAX_OPTION_CHARS)) {
    return refuse("Each option needs a short key and a short description.");
  }
  const state = body.state;
  if (!isRecord(state) || !Object.keys(state).every((key) => ROOM_STATE_KEYS.has(key)) || !ROOM_STATE_REQUIRED.every((key) => key in state)) {
    return refuse("The state is not a later.dog group chat.");
  }
  if (byteLength(state) > DECIDE_MAX_STATE_BYTES) return { ok: false, refusal: { status: 413, code: "too_large", message: "The state is too large." } };
  const criteria = Object.fromEntries(options) as Record<string, string>;
  return { ok: true, decision: { kind: "roomRouting", state, questions: { answer: { type: "choice", instructions: ROOM_ROUTING_INSTRUCTIONS, criteria } } } };
}

export function clefInput(decision: Decision) {
  return { model: CLEF_SELECTOR, state: decision.state, questions: decision.questions };
}

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
