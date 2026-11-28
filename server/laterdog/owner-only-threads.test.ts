import { describe, expect, it } from "vitest";
import type { Message } from "../store.ts";
import { OwnerOnlyThreads } from "./owner-only-threads.ts";

const line = (id: string): Message => ({ id, role: "user", kind: "text", text: id, at: 1 }) as Message;

describe("owner-only chats", () => {
  it("answers again from memory while a chat's last message is unchanged, and reads the whole chat only when it changes", () => {
    const chat = [line("a"), line("b")];
    let reads = 0;
    const threads = new OwnerOnlyThreads({
      lastMessage: () => chat.at(-1),
      wholeThread: () => { reads += 1; return [...chat]; },
      decide: (_id, thread) => thread.every((message) => message.text !== "stranger"),
    });
    expect(threads.ownerOnly("t1")).toBe(true);
    expect(threads.ownerOnly("t1")).toBe(true);
    expect(threads.ownerOnly("t1")).toBe(true);
    expect(reads).toBe(1);
    chat.push({ ...line("c"), text: "stranger" } as Message);
    expect(threads.ownerOnly("t1")).toBe(false);
    expect(reads).toBe(2);
  });
});
