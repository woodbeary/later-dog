import { describe, expect, it } from "vitest";
import { openWorkThread, threadLimitMessage, threadLimitNotice } from "./work-thread-reuse.ts";

const task = (threadId: string, over: Record<string, unknown> = {}) => ({
  threadId, createdAt: 1, updatedAt: 1, projectId: undefined as string | undefined,
  openedBy: { botId: "chief", name: "Chief", threadId: "chat", at: 1 } as { botId: string; name: string; threadId?: string; kind?: "work" | "pair"; at: number } | undefined,
  closedBy: undefined as { botId: string; name: string; at: number } | undefined,
  archivedAt: undefined as number | undefined,
  ...over,
});
const query = { senderId: "chief", sourceThreadId: "chat" };

describe("open work thread with a teammate", () => {
  it("finds the thread the same dog opened from the same conversation", () => {
    expect(openWorkThread([task("a")], query)?.threadId).toBe("a");
  });
  it("opens nothing again for another sender, another conversation or an unrelated thread", () => {
    expect(openWorkThread([task("a", { openedBy: { botId: "other", name: "Other", threadId: "chat", at: 1 } })], query)).toBeUndefined();
    expect(openWorkThread([task("a")], { ...query, sourceThreadId: "elsewhere" })).toBeUndefined();
    expect(openWorkThread([task("a", { openedBy: undefined })], query)).toBeUndefined();
    expect(openWorkThread([task("a", { openedBy: { botId: "chief", name: "Chief", at: 1 } })], query)).toBeUndefined();
  });
  it("skips closed and archived threads, but a finished work thread reopens", () => {
    const closedBy = { botId: "chief", name: "Chief", at: 2 };
    expect(openWorkThread([task("a", { closedBy })], query)).toBeUndefined();
    expect(openWorkThread([task("a", { archivedAt: 5 })], query)).toBeUndefined();
    expect(openWorkThread([task("a", { closedBy, openedBy: { botId: "chief", name: "Chief", threadId: "chat", kind: "work", at: 1 } })], query)?.threadId).toBe("a");
  });
  it("keeps to the folder it was asked for", () => {
    expect(openWorkThread([task("a", { projectId: "p1" })], { ...query, projectId: "p2" })).toBeUndefined();
    expect(openWorkThread([task("a", { projectId: "p1" })], { ...query, projectId: "p1" })?.threadId).toBe("a");
    expect(openWorkThread([task("a", { projectId: "p1" })], query)?.threadId).toBe("a");
  });
  it("prefers the established work thread, then the most recently used", () => {
    const work = task("work", { updatedAt: 1, openedBy: { botId: "chief", name: "Chief", threadId: "chat", kind: "work", at: 1 } });
    expect(openWorkThread([task("new", { updatedAt: 9 }), work], query)?.threadId).toBe("work");
    expect(openWorkThread([task("old", { updatedAt: 3 }), task("recent", { updatedAt: 8 })], query)?.threadId).toBe("recent");
  });
  it("says the limit in words a person can read", () => {
    expect(threadLimitMessage(5)).toContain("opened 5 new threads");
    expect(threadLimitMessage(5)).not.toMatch(/\buser\b/i);
    expect(threadLimitNotice(5)).toBe("notice: This dog opened 5 new threads in one go, so later.dog paused new ones to stop a runaway. Ask again if you want more.");
  });
});
