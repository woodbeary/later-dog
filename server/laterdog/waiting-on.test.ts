import { describe, expect, it } from "vitest";
import { waitingOn } from "./waiting-on.ts";

describe("the dogs a chat is waiting on", () => {
  const names: Record<string, string> = { patch: "Patch", rio: "Rio" };
  const nameOf = (botId: string) => names[botId];

  it("names each dog once, in the order the work went out, with the chat it went to and whether it's queued or running", () => {
    expect(waitingOn([
      { botId: "patch", threadId: "p-1", status: "queued" },
      { botId: "rio", threadId: "r-1", status: "waiting" },
      { botId: "patch", threadId: "p-2", status: "running" },
    ], nameOf)).toEqual([
      { botId: "patch", name: "Patch", threadId: "p-2", state: "running" },
      { botId: "rio", name: "Rio", threadId: "r-1", state: "queued" },
    ]);
  });

  it("leaves out a dog that no longer exists", () => {
    expect(waitingOn([{ botId: "gone" }, { botId: "rio" }], nameOf)).toEqual([{ botId: "rio", name: "Rio", state: "queued" }]);
    expect(waitingOn([], nameOf)).toEqual([]);
  });
});
