import type { Refusal } from "./auth";

export const COMPLETE_DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const COMPLETE_MAX_BODY_BYTES = 16 * 1024;
export const COMPLETE_MAX_PREFIX_CHARS = 1_500;
export const COMPLETE_MAX_MESSAGES = 6;
export const COMPLETE_MAX_MESSAGE_CHARS = 400;
export const COMPLETE_MAX_PHRASES = 3;
export const COMPLETE_MAX_PHRASE_CHARS = 120;
export const COMPLETE_MAX_DOG_CHARS = 40;
export const COMPLETE_MAX_OUTPUT_TOKENS = 20;
export const COMPLETE_TEMPERATURE = 0.2;
export const COMPLETE_MAX_WORDS = 12;
export const COMPLETE_MAX_CHARS = 120;
export const COMPLETIONS_PER_DAY = 4_000;
export const COMPLETIONS_TOTAL_PER_DAY = 2_000_000;

export type CompleteRole = "person" | "dog";

export interface CompleteMessage {
  role: CompleteRole;
  text: string;
}

export interface CompleteRequest {
  prefix: string;
  dog: string;
  messages: CompleteMessage[];
  phrasing: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const refuse = (message: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { status: 422, code: "invalid_request", message } });

const clip = (text: string, limit: number) => text.replace(/\s+/g, " ").trim().slice(0, limit);

export function completeRequest(body: unknown): { ok: true; request: CompleteRequest } | { ok: false; refusal: Refusal } {
  if (!isRecord(body)) return refuse("Send the text being typed.");
  const prefix = body.prefix;
  if (typeof prefix !== "string" || !prefix.trim()) return refuse("Send the text being typed.");
  if (prefix.length > COMPLETE_MAX_PREFIX_CHARS) return refuse(`Send at most ${COMPLETE_MAX_PREFIX_CHARS} characters.`);
  const dog = typeof body.dog === "string" ? clip(body.dog, COMPLETE_MAX_DOG_CHARS) : "";
  const messages: CompleteMessage[] = [];
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages) || body.messages.length > COMPLETE_MAX_MESSAGES) return refuse(`Send at most ${COMPLETE_MAX_MESSAGES} messages.`);
    for (const item of body.messages) {
      if (!isRecord(item) || (item.role !== "person" && item.role !== "dog") || typeof item.text !== "string") return refuse("Each message needs a role and text.");
      const text = clip(item.text, COMPLETE_MAX_MESSAGE_CHARS);
      if (text) messages.push({ role: item.role, text });
    }
  }
  const phrasing: string[] = [];
  if (body.phrasing !== undefined) {
    if (!Array.isArray(body.phrasing) || body.phrasing.length > COMPLETE_MAX_PHRASES || !body.phrasing.every((item) => typeof item === "string")) {
      return refuse(`Send at most ${COMPLETE_MAX_PHRASES} phrases.`);
    }
    for (const item of body.phrasing as string[]) {
      const text = clip(item, COMPLETE_MAX_PHRASE_CHARS);
      if (text) phrasing.push(text);
    }
  }
  return { ok: true, request: { prefix, dog, messages, phrasing } };
}

export function completeSystemPrompt(dog: string): string {
  const to = dog ? `a dog named ${dog}` : "a dog";
  return [
    `You finish the sentence a person is typing in the message box of a chat with ${to}, an AI assistant that does work for them.`,
    "Reply with only the words that come next, continuing exactly where the text stops, in the person's own voice and language.",
    "Start with a space if the last word is finished. Never repeat the text already typed. No quotes, no explanation, no new line.",
    `At most ${COMPLETE_MAX_WORDS} words. If you cannot tell what they want to say, reply with nothing.`,
  ].join(" ");
}

export function completeUserPrompt(request: CompleteRequest): string {
  const parts: string[] = [];
  if (request.messages.length) {
    parts.push("Recent messages, oldest first:");
    for (const message of request.messages) parts.push(`${message.role === "person" ? "Person" : request.dog || "Dog"}: ${message.text}`);
  }
  if (request.phrasing.length) {
    parts.push("How the person usually writes:");
    for (const phrase of request.phrasing) parts.push(`- ${phrase}`);
  }
  parts.push("The person has typed so far (continue it):");
  parts.push(request.prefix);
  return parts.join("\n");
}

export function completeInput(request: CompleteRequest) {
  return {
    messages: [
      { role: "system", content: completeSystemPrompt(request.dog) },
      { role: "user", content: completeUserPrompt(request) },
    ],
    max_tokens: COMPLETE_MAX_OUTPUT_TOKENS,
    temperature: COMPLETE_TEMPERATURE,
  };
}

function textOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const result = isRecord(raw.result) ? raw.result : raw;
  if (typeof result.response === "string") return result.response;
  if (Array.isArray(result.choices)) {
    const first = result.choices[0];
    const message = isRecord(first) && isRecord(first.message) ? first.message.content : undefined;
    if (typeof message === "string") return message;
  }
  return null;
}

export function finishCompletion(prefix: string, raw: string): string {
  const line = (raw.split("\n")[0] ?? "").replace(/^(\s*)["'`]+/, "$1").replace(/["'`]+\s*$/, "");
  const typed = prefix.trimEnd();
  let rest = line;
  if (typed && line.trimStart().toLowerCase().startsWith(typed.toLowerCase())) rest = line.trimStart().slice(typed.length);
  const words = rest.trim().split(/\s+/).filter(Boolean).slice(0, COMPLETE_MAX_WORDS).join(" ");
  if (!words) return "";
  const prefixEndsInSpace = /\s$/.test(prefix);
  const spaced = /^\s/.test(rest) || /[.,;:!?)]$/.test(prefix);
  const lead = !prefixEndsInSpace && spaced ? " " : "";
  return (lead + words).slice(0, COMPLETE_MAX_CHARS).trimEnd();
}

export function completionFrom(prefix: string, raw: unknown): string | null {
  const text = textOf(raw);
  if (text === null) return null;
  return finishCompletion(prefix, text);
}
