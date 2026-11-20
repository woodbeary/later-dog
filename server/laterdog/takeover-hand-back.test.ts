import { describe, expect, it } from "vitest";
import type { TakeoverRequestCardData, TakeoverStatus } from "../../shared/takeover.ts";
import { heldTakeoverCards, takeoversToHandBack } from "./takeover-hand-back.ts";
import type { TakeoverWait } from "./takeover.ts";

const request = (status: TakeoverStatus): TakeoverRequestCardData => ({ step: "Type the code from the text", reason: "sign-in", helpRequestId: "rex-1", status, place: "cloud" });
const asked = (id: string, status: TakeoverStatus, from?: string) => ({ id, kind: "options", ...(from ? { from: { botId: from } } : {}), card: { takeoverRequest: request(status) } });

describe("which steps I'm done in the screen window hands back", () => {
  it("finds the steps the person has taken in each of the dog's chats, and only the dog's own", () => {
    const threads = [
      { threadId: "main", messages: [asked("a", "done"), asked("b", "in-control"), { id: "c", kind: "text" }] },
      { threadId: "task", messages: [asked("d", "waiting"), asked("e", "in-control", "rex"), asked("f", "in-control", "pip")] },
    ];
    expect(heldTakeoverCards("rex", threads)).toEqual([
      { botId: "rex", threadId: "main", messageId: "b" },
      { botId: "rex", threadId: "task", messageId: "e" },
    ]);
  });

  it("ends each open step once, whether it was found in a chat or is still awaited, and never one that already ended", () => {
    const cards = new Map<string, TakeoverRequestCardData>([
      ["main:b", request("in-control")],
      ["task:d", request("waiting")],
      ["task:x", request("skipped")],
    ]);
    const read = (wait: TakeoverWait) => cards.get(`${wait.threadId}:${wait.messageId}`) ?? null;
    const b = { botId: "rex", threadId: "main", messageId: "b" };
    const d = { botId: "rex", threadId: "task", messageId: "d" };
    const x = { botId: "rex", threadId: "task", messageId: "x" };
    const gone = { botId: "rex", threadId: "task", messageId: "gone" };
    expect(takeoversToHandBack([d, b, x, gone], [b], read)).toEqual([d, b]);
    expect(takeoversToHandBack([], [], read)).toEqual([]);
  });
});
