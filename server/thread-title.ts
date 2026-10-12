import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export const TITLE_INPUT_MAX_CHARS = 1_500;
const EXCERPT_MAX_MESSAGES = 12;
const EXCERPT_LINE_MAX_CHARS = 300;
const ATTACHMENT_TAG = /<attached-(?:image|file)\b[^>]*\/>/g;

export type ThreadTitleSource = "first-message" | "conversation";

export function threadTitlePrompt(text: string, source: ThreadTitleSource = "first-message"): string {
  return [
    source === "conversation"
      ? "Name the conversation below by what it is about now."
      : "Name the conversation that begins with the message below.",
    "Reply with only a short title: 3 to 6 words, plain text, no quotes, no trailing period.",
    source === "conversation" ? "Conversation:" : "Message:",
    text.trim().slice(0, TITLE_INPUT_MAX_CHARS),
  ].join("\n");
}

export function titleConversationExcerpt(messages: readonly Message[]): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = messages.length - 1; index >= 0 && lines.length < EXCERPT_MAX_MESSAGES; index--) {
    const message = messages[index]!;
    if (message.kind !== "text" || !message.text || message.aside || message.queued) continue;
    const text = redactSecretsInText(message.text.replace(ATTACHMENT_TAG, " ")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const clipped = text.length > EXCERPT_LINE_MAX_CHARS ? `${text.slice(0, EXCERPT_LINE_MAX_CHARS - 1)}…` : text;
    const line = `${message.role === "user" ? "User" : "Bot"}: ${clipped}`;
    if (length + line.length + 1 > TITLE_INPUT_MAX_CHARS) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.reverse().join("\n");
}
