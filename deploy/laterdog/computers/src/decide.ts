import type { Refusal } from "./auth";

export const CLEF_MODEL = "@cf/cloudflare/clef";
export const CLEF_SELECTOR = "clef";
export const DECIDE_MODELS = {
  clef: CLEF_MODEL,
  "clef-flash": "@cf/cloudflare/clef-flash",
  "clef-omni": "@cf/cloudflare/clef-omni",
} as const;
export type DecideModel = keyof typeof DECIDE_MODELS;
export const DECIDE_MAX_BODY_BYTES = 64 * 1024;
export const DECIDE_MAX_IMAGE_BODY_BYTES = 512 * 1024;
export const DECIDE_MAX_IMAGES = 4;
export const DECIDE_MAX_IMAGE_CHARS = 190_000;
export const DECIDE_MAX_STATE_BYTES = 24_000;
export const DECIDE_MAX_OPTIONS = 64;
export const DECIDE_MAX_OPTION_CHARS = 600;
export const DECISIONS_PER_DAY = 500;
export const DECISIONS_TOTAL_PER_DAY = 100_000;
export const VOICE_CHARS_TOTAL_PER_DAY = 400_000;

export type UsageKind = "decisions" | "voice_chars" | "ai_tokens" | "transcribe_seconds";

export const KEY_CHECK_STATE = { purpose: "later.dog is checking that a decision-model key works." };
export const KEY_CHECK_QUESTION = "Is this a connection check?";
export const ROOM_ROUTING_INSTRUCTIONS =
  "Which bot in this room should answer `new_message`? Choose __everyone__ only when the message needs several members to answer.";
const ROOM_STATE_KEYS = new Set(["room", "humans_in_room", "bots_in_room", "recent_messages", "new_message"]);
const ROOM_STATE_REQUIRED = ["room", "humans_in_room", "bots_in_room", "new_message"];

export type Decision = { model: DecideModel; images: string[] } & (
  | { kind: "keyCheck"; state: unknown; questions: { answer: { type: "noul"; instructions: string } } }
  | { kind: "roomRouting"; state: Record<string, unknown>; questions: { answer: { type: "choice"; instructions: string; criteria: Record<string, string> } } }
);

const IMAGE_DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const IMAGE_SIGNATURES: Record<string, (bytes: string) => boolean> = {
  jpeg: (bytes) => bytes.startsWith("\xff\xd8\xff"),
  png: (bytes) => bytes.startsWith("\x89PNG"),
  webp: (bytes) => bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const refuse = (message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status: 422, code: "unsupported_decision", message } });

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const tooLarge = (message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status: 413, code: "too_large", message } });

function modelFrom(value: unknown): DecideModel {
  return typeof value === "string" && Object.hasOwn(DECIDE_MODELS, value) ? (value as DecideModel) : CLEF_SELECTOR;
}

function imagesFrom(value: unknown): { ok: true; images: string[] } | { ok: false; refusal: Refusal } {
  if (value === undefined) return { ok: true, images: [] };
  if (!Array.isArray(value) || value.length > DECIDE_MAX_IMAGES) return refuse(`Send at most ${DECIDE_MAX_IMAGES} images as an array.`);
  for (const image of value) {
    if (typeof image !== "string") return refuse("Each image must be a base64 data URL.");
    if (image.length > DECIDE_MAX_IMAGE_CHARS) return tooLarge(`Each image must be under ${Math.floor(DECIDE_MAX_IMAGE_CHARS / 1000)} KB as a data URL. Shrink it before sending.`);
    const match = IMAGE_DATA_URL.exec(image);
    if (!match) return refuse("Each image must be a base64 data URL of a JPEG, PNG or WebP.");
    let head: string;
    try {
      head = atob(match[2]!.slice(0, 16));
    } catch {
      return refuse("Each image must be a base64 data URL of a JPEG, PNG or WebP.");
    }
    if (!IMAGE_SIGNATURES[match[1]!]!(head)) return refuse("An image does not match its type.");
  }
  return { ok: true, images: value as string[] };
}

export function decisionFrom(body: unknown): { ok: true; decision: Decision } | { ok: false; refusal: Refusal } {
  if (!isRecord(body) || !isRecord(body.questions)) return refuse("Send a state and one question.");
  const images = imagesFrom(body.images);
  if (!images.ok) return images;
  if (images.images.length === 0 && byteLength(body) > DECIDE_MAX_BODY_BYTES) return tooLarge("The body is too large.");
  const model = modelFrom(body.model);
  const ids = Object.keys(body.questions);
  const question = body.questions.answer;
  if (ids.length !== 1 || !isRecord(question)) return refuse("This service answers one question, named answer.");
  if (question.type === "noul") {
    if (question.instructions !== KEY_CHECK_QUESTION || question.criteria !== undefined || JSON.stringify(body.state) !== JSON.stringify(KEY_CHECK_STATE)) {
      return refuse("This service only answers later.dog's own questions.");
    }
    if (images.images.length > 0) return refuse("A connection check takes no images.");
    return { ok: true, decision: { kind: "keyCheck", model, images: [], state: KEY_CHECK_STATE, questions: { answer: { type: "noul", instructions: KEY_CHECK_QUESTION } } } };
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
  return { ok: true, decision: { kind: "roomRouting", model, images: images.images, state, questions: { answer: { type: "choice", instructions: ROOM_ROUTING_INSTRUCTIONS, criteria } } } };
}

export function clefInput(decision: Decision) {
  return {
    model: decision.model,
    state: decision.state,
    questions: decision.questions,
    ...(decision.images.length > 0 ? { images: decision.images } : {}),
  };
}

export const clefModelId = (decision: Decision) => DECIDE_MODELS[decision.model];

export function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}
