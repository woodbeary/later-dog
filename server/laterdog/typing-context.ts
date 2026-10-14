import { looksSecret, redactSecrets } from "../../shared/typing-secrets.ts";

export { looksSecret, redactSecrets };

export const TYPING_MAX_PREFIX_CHARS = 1_500;
export const TYPING_MAX_MESSAGES = 6;
export const TYPING_MAX_MESSAGE_CHARS = 400;
export const TYPING_MAX_PHRASES = 3;
export const TYPING_MAX_PHRASE_CHARS = 120;
export const TYPING_MAX_DOG_CHARS = 40;
export const TYPING_MAX_OUTPUT_TOKENS = 20;
export const TYPING_TEMPERATURE = 0.2;
export const TYPING_MAX_WORDS = 12;
export const TYPING_MAX_CHARS = 120;

export type TypingRole = "person" | "dog";

export interface TypingMessage {
  role: TypingRole;
  text: string;
}

export interface TypingRequest {
  prefix: string;
  dog: string;
  messages: TypingMessage[];
  phrasing: string[];
}

const ATTACHMENT_TAGS = /<(attached-[a-z-]+|transcript-citation|file|thread-ref)\b[\s\S]*?(?:<\/\1>|\/>|>)/gi;
const CODE_FENCE = /```[\s\S]*?(?:```|$)/g;
const FILE_PATH = /(?:^|\s)(?:~|\.{0,2})\/[^\s]{3,}/g;

export function plainContext(text: string, limit: number): string {
  const stripped = text.replace(ATTACHMENT_TAGS, " ").replace(CODE_FENCE, " ").replace(FILE_PATH, " ");
  return redactSecrets(stripped).replace(/\s+/g, " ").trim().slice(0, limit);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type ParsedTyping = { ok: true; request: TypingRequest } | { ok: false; error: string };

export function parseTypingRequest(body: unknown): ParsedTyping {
  if (!isRecord(body)) return { ok: false, error: "Send the text being typed." };
  const prefix = body.prefix;
  if (typeof prefix !== "string" || !prefix.trim()) return { ok: false, error: "Send the text being typed." };
  if (prefix.length > TYPING_MAX_PREFIX_CHARS) return { ok: false, error: `Send at most ${TYPING_MAX_PREFIX_CHARS} characters.` };
  const dog = typeof body.dog === "string" ? plainContext(body.dog, TYPING_MAX_DOG_CHARS) : "";
  const messages: TypingMessage[] = [];
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) return { ok: false, error: "Send the recent messages as a list." };
    for (const item of body.messages.slice(-TYPING_MAX_MESSAGES)) {
      if (!isRecord(item) || (item.role !== "person" && item.role !== "dog") || typeof item.text !== "string") {
        return { ok: false, error: "Each message needs a role and text." };
      }
      const text = plainContext(item.text, TYPING_MAX_MESSAGE_CHARS);
      if (text) messages.push({ role: item.role, text });
    }
  }
  const phrasing: string[] = [];
  if (body.phrasing !== undefined) {
    if (!Array.isArray(body.phrasing) || !body.phrasing.every((item) => typeof item === "string")) return { ok: false, error: "Send the phrases as a list." };
    for (const item of (body.phrasing as string[]).slice(0, TYPING_MAX_PHRASES)) {
      const text = plainContext(item, TYPING_MAX_PHRASE_CHARS);
      if (text) phrasing.push(text);
    }
  }
  return { ok: true, request: { prefix, dog, messages, phrasing } };
}

export function typingSystemPrompt(dog: string): string {
  const to = dog ? `a dog named ${dog}` : "a dog";
  return [
    `You finish the sentence a person is typing in the message box of a chat with ${to}, an AI assistant that does work for them.`,
    "Reply with only the words that come next, continuing exactly where the text stops, in the person's own voice and language.",
    "Start with a space if the last word is finished. Never repeat the text already typed. No quotes, no explanation, no new line.",
    `At most ${TYPING_MAX_WORDS} words. If you cannot tell what they want to say, reply with nothing.`,
  ].join(" ");
}

export function typingUserPrompt(request: TypingRequest): string {
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

export function typingModelInput(request: TypingRequest) {
  return {
    messages: [
      { role: "system", content: typingSystemPrompt(request.dog) },
      { role: "user", content: typingUserPrompt(request) },
    ],
    max_tokens: TYPING_MAX_OUTPUT_TOKENS,
    temperature: TYPING_TEMPERATURE,
  };
}

export function finishCompletion(prefix: string, raw: string): string {
  const line = (raw.split("\n")[0] ?? "").replace(/^(\s*)["'`]+/, "$1").replace(/["'`]+\s*$/, "");
  const typed = prefix.trimEnd();
  let rest = line;
  if (typed && line.trimStart().toLowerCase().startsWith(typed.toLowerCase())) rest = line.trimStart().slice(typed.length);
  const words = rest.trim().split(/\s+/).filter(Boolean).slice(0, TYPING_MAX_WORDS).join(" ");
  if (!words || looksSecret(words)) return "";
  const prefixEndsInSpace = /\s$/.test(prefix);
  const spaced = /^\s/.test(rest) || /[.,;:!?)]$/.test(prefix);
  const lead = !prefixEndsInSpace && spaced ? " " : "";
  return (lead + words).slice(0, TYPING_MAX_CHARS).trimEnd();
}
