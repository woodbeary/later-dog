import { describe, expect, it } from "vitest";
import { teammateNames, waitingOnPreview, waitingOnStatus } from "./waiting-on";

describe("who a dog is waiting on", () => {
  it("names the dogs in plain words", () => {
    expect(teammateNames([{ botId: "patch", name: "Patch" }], "en")).toBe("Patch");
    expect(teammateNames([{ botId: "patch", name: "Patch" }, { botId: "rio", name: "Rio" }], "en")).toBe("Patch and Rio");
    expect(teammateNames([{ botId: "patch", name: "Patch" }, { botId: "patch", name: "Patch" }], "en")).toBe("Patch");
    expect(teammateNames([], "en")).toBeNull();
    expect(teammateNames(undefined, "en")).toBeNull();
  });

  it("says who in the chat header and the sidebar, and keeps the old words when no dog is named", () => {
    expect(waitingOnStatus([{ botId: "patch", name: "Patch" }])).toBe("Waiting on Patch");
    expect(waitingOnPreview([{ botId: "patch", name: "Patch" }])).toBe("Waiting on Patch…");
    expect(waitingOnStatus([])).toBe("Other dogs working");
    expect(waitingOnPreview(undefined)).toBe("Waiting on another dog…");
  });
});
