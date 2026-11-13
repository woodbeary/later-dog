import type { WireMessage } from "../../shared/wire.ts";

type Reaction = NonNullable<WireMessage["reactions"]>[number];

export const TAPBACK_PROMPT =
  " When a message needs no answer, such as \"ok\", \"thanks\", \"👍\" or \"got it\", reply with one emoji and nothing else; the app shows it as a tapback on their message. To react in the middle of work, use the react tool and carry on.";

export const TAPBACK_NOTE = " If it only acknowledges, such as \"ok\" or \"thanks\", reply with one emoji and nothing else; the app shows it as a tapback.";

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const NOT_EMOJI = /[\p{L}\p{N}\s]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function tapbackEmoji(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const emoji = input.trim();
  if (!emoji || emoji.length > 16 || !EMOJI.test(emoji) || NOT_EMOJI.test(emoji)) return null;
  return [...graphemes.segment(emoji)].length === 1 ? emoji : null;
}

export function tapbackTarget(path: ReadonlyArray<WireMessage>, messageId?: string): WireMessage | null {
  if (messageId) return path.find((message) => message.id === messageId && message.kind === "text") ?? null;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const message = path[index]!;
    if (message.role === "user" && message.kind === "text" && !message.peerAsk && !message.from?.botId) return message;
  }
  return null;
}

export function withTapback(reactions: ReadonlyArray<Reaction> | undefined, emoji: string, by: string): Reaction[] {
  return [...(reactions ?? []).filter((reaction) => reaction.by !== by), { emoji, by }];
}

const WHOLE_TAG = /<\/?[A-Za-z_|][^<>]*>/g;
const OPEN_TAG_AT_END = /<[^<>]*$/;

function withoutMarkup(text: string): string {
  return text.replace(WHOLE_TAG, "").replace(OPEN_TAG_AT_END, "");
}

export function onlyTapbackText(text: string | undefined): boolean {
  return [...graphemes.segment(withoutMarkup(text ?? ""))].every(({ segment }) => /^[\p{P}\p{S}\s]+$/u.test(segment) || tapbackEmoji(segment) !== null);
}

export function tapbackStreamChunk(buffered: string | undefined, delta: string): { pending?: string; delta?: string } {
  if (buffered === undefined) return { delta };
  const text = buffered + delta;
  return onlyTapbackText(text) ? { pending: text } : { delta: text };
}

const BARE_TAG = /<\/?\|?[A-Za-z_][\w.:-]*\|?>/g;
const BARE_TAG_AT_END = /<\/?\|?(?:[A-Za-z_][\w.:-]*)?$/;
const REACT_NAME = /^[\w.:-]*react$/i;
const ARGUMENT_KEYS = ["arguments", "parameters", "input"];
const MAX_REPLY_TAPBACK = 240;

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function emojiArguments(value: unknown): string | null {
  const args = typeof value === "string" ? parsed(value) : value;
  if (!plainObject(args) || Object.keys(args).join() !== "emoji") return null;
  return tapbackEmoji(args.emoji);
}

function reactCall(value: unknown): string | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.join() === "emoji") return emojiArguments(value);
  const argumentKey = keys.find((key) => ARGUMENT_KEYS.includes(key));
  if (keys.length !== 2 || !argumentKey || typeof value.name !== "string" || !REACT_NAME.test(value.name)) return null;
  return emojiArguments(value[argumentKey]);
}

export function replyTapback(text: string | undefined): string | null {
  if (!text || text.length > MAX_REPLY_TAPBACK) return null;
  const inner = text.replace(BARE_TAG, " ").trim();
  if (!inner) return null;
  return tapbackEmoji(inner) ?? (inner.startsWith("{") ? reactCall(parsed(inner)) : null);
}

const JSON_PUNCTUATION = /^[\s{}[\]:,]*$/;
const QUOTED = /"((?:[^"\\]|\\.)*)("?)/g;

function quotedWordFits(word: string, closed: boolean): boolean {
  if (ARGUMENT_KEYS.includes(word) || word === "emoji" || word === "name" || REACT_NAME.test(word)) return true;
  if (word.startsWith("{")) return true;
  if (!word || tapbackEmoji(word) !== null || /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f)+$/u.test(word)) return true;
  return !closed && /^[\w.:-]*$/.test(word);
}

function couldBeReactCall(text: string): boolean {
  let outside = "";
  let at = 0;
  for (const match of text.matchAll(QUOTED)) {
    outside += text.slice(at, match.index);
    at = match.index! + match[0].length;
    if (!quotedWordFits(match[1]!, match[2] === "\"")) return false;
  }
  outside += text.slice(at);
  return JSON_PUNCTUATION.test(outside);
}

export function couldBeReplyTapback(text: string): boolean {
  if (text.length > MAX_REPLY_TAPBACK) return false;
  const inner = text.replace(BARE_TAG, " ").replace(BARE_TAG_AT_END, "").trim();
  if (!inner) return true;
  if (inner.startsWith("{")) return couldBeReactCall(inner);
  if (/[<>]/.test(inner)) return false;
  return [...graphemes.segment(inner)].length === 1 && !NOT_EMOJI.test(inner) && (EMOJI.test(inner) || /^(?:\p{Emoji_Modifier}|\u200d|\ufe0f)+$/u.test(inner));
}

export function replyTapbackStreamChunk(held: string | null | undefined, delta: string): { pending?: string; delta?: string } {
  if (held === null) return { delta };
  const text = (held ?? "") + delta;
  return couldBeReplyTapback(text) ? { pending: text } : { delta: text };
}

export function tapbackTurnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

export function reactedText(emoji: string, target: Pick<WireMessage, "text">): string {
  const said = (target.text ?? "").replace(/\s+/g, " ").trim();
  const quoted = said.length > 60 ? `${said.slice(0, 57)}…` : said;
  return `Reacted ${emoji} to ${quoted ? `“${quoted}”` : "the message"}. Carry on with your work; if there is none, end your turn without writing anything.`;
}
