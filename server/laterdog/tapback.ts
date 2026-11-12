import type { WireMessage } from "../../shared/wire.ts";

type Reaction = NonNullable<WireMessage["reactions"]>[number];

export const TAPBACK_PROMPT =
  " When a message needs no answer, such as \"ok\", \"thanks\", \"👍\" or \"got it\", react to it with the react tool and end your turn without writing anything: the tapback is the whole reply. While you work, for a plain acknowledgment sent mid-task, the reaction is the short reply, so react and carry on.";

export const TAPBACK_NOTE = " If it only acknowledges, such as \"ok\" or \"thanks\", react to it with the react tool instead; that tapback is the reply.";

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

export function onlyTapbackText(text: string | undefined): boolean {
  return [...graphemes.segment(text ?? "")].every(({ segment }) => /^[\p{P}\s]+$/u.test(segment) || tapbackEmoji(segment) !== null);
}

export function tapbackStreamChunk(buffered: string | undefined, delta: string): { pending?: string; delta?: string } {
  if (buffered === undefined) return { delta };
  const text = buffered + delta;
  return onlyTapbackText(text) ? { pending: text } : { delta: text };
}

export function tapbackTurnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

export function reactedText(emoji: string, target: Pick<WireMessage, "text">): string {
  const said = (target.text ?? "").replace(/\s+/g, " ").trim();
  const quoted = said.length > 60 ? `${said.slice(0, 57)}…` : said;
  return `Reacted ${emoji} to ${quoted ? `“${quoted}”` : "the message"}. End your turn now without writing anything unless there is more to say; the reaction is the reply.`;
}
