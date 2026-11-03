import { describe, expect, it } from "vitest";
import { waitingOn } from "./waiting-on.ts";

describe("the dogs a chat is waiting on", () => {
  const names: Record<string, string> = { patch: "Patch", rio: "Rio" };
  const nameOf = (botId: string) => names[botId];

  it("names each dog once, in the order the work went out", () => {
    expect(waitingOn([{ botId: "patch" }, { botId: "rio" }, { botId: "patch" }], nameOf)).toEqual([
      { botId: "patch", name: "Patch" },
      { botId: "rio", name: "Rio" },
    ]);
  });

  it("leaves out a dog that no longer exists", () => {
    expect(waitingOn([{ botId: "gone" }, { botId: "rio" }], nameOf)).toEqual([{ botId: "rio", name: "Rio" }]);
    expect(waitingOn([], nameOf)).toEqual([]);
  });
});
