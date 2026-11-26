import { describe, expect, it } from "vitest";
import { cacheLine } from "./cache-line.ts";

describe("cache line", () => {
  it("names the chat, account and the three token counts", () => {
    expect(cacheLine({ threadId: "t1", instanceId: "claude", input: 1000, cachedInput: 900, cachedWrite: 50 }))
      .toBe("[cache] chat=t1 account=claude input=1000 cached=900 written=50");
  });

  it("writes zero for what the provider did not report beside what it did", () => {
    expect(cacheLine({ threadId: "t1", instanceId: "codex", input: 10, cachedInput: 4 })).toBe("[cache] chat=t1 account=codex input=10 cached=4 written=0");
    expect(cacheLine({ threadId: "t1", instanceId: "claude", input: 10, cachedWrite: 10 })).toBe("[cache] chat=t1 account=claude input=10 cached=0 written=10");
  });

  it("never reports more cached than input", () => {
    expect(cacheLine({ threadId: "t", instanceId: "a", input: 5, cachedInput: 9 })).toContain("cached=5");
  });

  it("says nothing when the provider reported no cache numbers or no input", () => {
    expect(cacheLine({ threadId: "t", instanceId: "a", input: 5 })).toBeNull();
    expect(cacheLine({ threadId: "t", instanceId: "a", input: 0, cachedInput: 0 })).toBeNull();
  });
});
