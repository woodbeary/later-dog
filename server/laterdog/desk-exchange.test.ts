import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { recordDeskExchange } from "./desk-exchange.ts";

function memoryStore() {
  const threads = new Map<string, Message[]>();
  let next = 0;
  return {
    threads,
    messagesFor: (threadId: string) => threads.get(threadId) ?? [],
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const full = { id: `m${++next}`, at: next, ...message } as Message;
      threads.set(threadId, [...(threads.get(threadId) ?? []), full]);
      return full;
    },
  };
}

describe("a reply the desk wrote while the home slept", () => {
  it("lands as the person's line and the dog's finished answer, once", () => {
    const store = memoryStore();
    const input = { threadId: "t-rex", text: "hello?", sendId: "send-0000000000001", reply: { text: "Hi! I'm here.", model: "kimi-k2.6" } };
    const receipt = recordDeskExchange(store, input);
    expect(receipt).toMatchObject({ ok: true, threadId: "t-rex", message: { role: "user", text: "hello?", sendId: "send-0000000000001" } });
    expect(store.messagesFor("t-rex").map(({ role, kind, text, turnTerminal }) => ({ role, kind, text, turnTerminal }))).toEqual([
      { role: "user", kind: "text", text: "hello?", turnTerminal: undefined },
      { role: "bot", kind: "text", text: "Hi! I'm here.", turnTerminal: true },
    ]);
    expect(recordDeskExchange(store, input).message.id).toBe(receipt.message.id);
    expect(store.messagesFor("t-rex")).toHaveLength(2);
  });
});
