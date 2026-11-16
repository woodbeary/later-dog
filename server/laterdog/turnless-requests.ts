import type { WireMessage } from "../../shared/wire.ts";

export const TURNLESS_MS = 10 * 60_000;
export const SETTLED_BY_HOME = "later.dog settled this after its dog had stopped working on it. What the dog last said in its chat:";
export const TAKEN_OVER = "Another turn started in this dog's chat before its turn for this request finished. What the dog last said in its chat:";
export const NO_LAST_WORDS = "Nothing; its turn ended without a reply.";

export function settledByHome(lastWords: string | undefined): string {
  return `${SETTLED_BY_HOME}\n${lastWords?.trim() || NO_LAST_WORDS}`;
}

export function lastWords(messages: readonly Pick<WireMessage, "role" | "kind" | "text">[]): string | undefined {
  return messages.findLast(message => message.role === "bot" && message.kind === "text" && Boolean(message.text?.trim()))?.text;
}

export function takenOverText(lastWords: string | undefined): string {
  return `${TAKEN_OVER}\n${lastWords?.trim() || NO_LAST_WORDS}`;
}

export function takenOver<Settle>(turns: ReadonlyMap<string, { threadId: string }>, settlers: ReadonlyMap<string, Settle>,
  threadId: string, carriedOn: Settle | undefined): string[] {
  return [...settlers].filter(([generation, settle]) => settle !== carriedOn && turns.get(generation)?.threadId === threadId)
    .map(([generation]) => generation);
}
