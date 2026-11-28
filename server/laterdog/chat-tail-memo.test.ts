import { describe, expect, it } from "vitest";

import { chatTailMemo } from "./chat-tail-memo.ts";

describe("chat tail memo", () => {
  it("reads a chat once until that chat changes", () => {
    const reads: string[] = [];
    const memo = chatTailMemo((threadId) => { reads.push(threadId); return reads.length === 1 ? undefined : "Approve the sign-in"; });
    expect(memo.get("a")).toBeUndefined();
    expect(memo.get("a")).toBeUndefined();
    memo.changed({ type: "bot", botId: "dog" });
    memo.changed({ type: "message", threadId: "b", message: { id: "1", at: 1, role: "user", kind: "text", text: "hi" } });
    expect(memo.get("a")).toBeUndefined();
    expect(reads).toEqual(["a"]);
    memo.changed({ type: "message.patch", threadId: "a", message: { id: "1", at: 1, role: "bot", kind: "options" } });
    expect(memo.get("a")).toBe("Approve the sign-in");
    memo.changed({ type: "thread.deleted", threadId: "a" });
    memo.get("a");
    expect(reads).toEqual(["a", "a", "a"]);
  });
});
