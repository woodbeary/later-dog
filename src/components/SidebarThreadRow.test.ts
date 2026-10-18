import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { formatUpdatedAt, orderedSidebarThreads, orderedThreadList, stampClock, threadByline, threadOpenerLabel, threadUpdatedLabel } from "./SidebarThreadRow";

afterEach(() => setLocale("en"));

describe("thread bylines", () => {
  const openedBy = { botId: "scout", name: "Scout", at: 5 };
  it("says who opened the thread in plain words, and nothing for the person's own", () => {
    expect(threadOpenerLabel({ openedBy })).toBe("opened by Scout");
    expect(threadOpenerLabel({})).toBeNull();
    expect(threadOpenerLabel({ openedBy: { ...openedBy, name: "  " } })).toBeNull();
  });
  it("prefers closed, then archived, then snoozed, then the opener", () => {
    expect(threadByline({ archivedAt: 5 })).toBe("Archived");
    expect(threadByline({ archivedAt: 0 })).toBe("Archived");
    expect(threadByline({ openedBy, archivedAt: 5 })).toBe("Archived");
    expect(threadByline({ openedBy })).toBe("opened by Scout");
    expect(threadByline({ openedBy, archivedAt: 5, closedBy: { botId: "pm", name: "Parker", at: 2 } })).toBe("closed by Parker");
    expect(threadByline({ snoozedUntil: 0 })).toBe("Snoozed");
  });
});

describe("formatUpdatedAt", () => {
  it("uses the runtime locale and timezone, and skips a missing stamp", () => {
    const at = Date.UTC(2026, 0, 15, 0, 30);
    expect(formatUpdatedAt(at)).toBe(new Date(at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }));
    expect(formatUpdatedAt(0)).toBe("");
    expect(formatUpdatedAt(Number.NaN)).toBe("");
  });
});

describe("threadUpdatedLabel", () => {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0);
  const label = (ageMs: number) => threadUpdatedLabel(now - ageMs, now);

  it("sharpens the newest work, then falls back to the absolute date past a week", () => {
    expect(label(10_000)).toBe("just now");
    expect(label(44_000)).toBe("just now");
    expect(label(5 * 60_000)).toBe("5 min ago");
    expect(label(59 * 60_000)).toBe("59 min ago");
    expect(label(3 * 3_600_000)).toBe("3 h ago");
    expect(label(26 * 3_600_000)).toBe("yesterday");
    expect(label(2 * 86_400_000)).toBe("2 d ago");
    expect(label(6 * 86_400_000)).toBe("6 d ago");
    expect(label(7 * 86_400_000)).toBe(formatUpdatedAt(now - 7 * 86_400_000));
  });

  it("keeps the seventh day relative until a full week has elapsed", () => {
    expect(label(6 * 86_400_000 + 12 * 3_600_000)).toBe("7 d ago");
  });

  it("keeps a same-day update in the hour tier until a full day has elapsed", () => {
    const morning = Date.UTC(2026, 8, 25, 0, 15, 0);
    const night = Date.UTC(2026, 8, 25, 23, 45, 0);
    expect(threadUpdatedLabel(morning, night)).toBe("24 h ago");
  });

  it("gives a row the clock exactly while its label reads relative", () => {
    const halfPastSix = 6 * 86_400_000 + 12 * 3_600_000;
    expect(stampClock(now - halfPastSix, now)).toBe(now);
    expect(stampClock(now - 7 * 86_400_000, now)).toBeUndefined();
    expect(stampClock(0, now)).toBeUndefined();
    expect(stampClock(now - 60_000, Number.NaN)).toBeUndefined();
    expect(threadUpdatedLabel(now - 60_000, Number.NaN)).toBe(formatUpdatedAt(now - 60_000));
  });

  it("skips a missing stamp and clamps a future clock to just now", () => {
    expect(threadUpdatedLabel(0, now)).toBe("");
    expect(threadUpdatedLabel(Number.NaN, now)).toBe("");
    expect(label(-30_000)).toBe("just now");
  });

  it("translates through the locale catalog", () => {
    setLocale("pt-br");
    expect(threadUpdatedLabel(now - 5 * 60_000, now)).toBe("há 5 min");
    expect(threadUpdatedLabel(now - 26 * 3_600_000, now)).toBe("ontem");
  });
});

describe("orderedThreadList", () => {
  const task = (threadId: string, over: Record<string, unknown> = {}) => ({
    threadId,
    title: threadId,
    createdAt: 1,
    ...over,
  });

  it("pins first, then newest update, and keeps equal stamps in stored order", () => {
    const ordered = orderedThreadList([
      task("old", { updatedAt: 10 }),
      task("pinned-old", { pinned: true, updatedAt: 5 }),
      task("new", { updatedAt: 30 }),
      task("pinned-new", { pinned: true, updatedAt: 20 }),
      task("tie-b", { updatedAt: 10 }),
    ]);
    expect(ordered.map((item) => item.threadId)).toEqual(["pinned-new", "pinned-old", "new", "old", "tie-b"]);
  });

  it("does not let waiting or working outrank a newer idle thread", () => {
    const ordered = orderedThreadList([
      task("waiting", { updatedAt: 1, activity: "waiting-on-you" }),
      task("fresh", { updatedAt: 5 }),
    ]);
    expect(ordered.map((item) => item.threadId)).toEqual(["fresh", "waiting"]);
  });

  it("uses createdAt when the thread has never been updated", () => {
    const ordered = orderedThreadList([
      task("created-early", { createdAt: 1 }),
      task("created-late", { createdAt: 4 }),
    ]);
    expect(ordered.map((item) => item.threadId)).toEqual(["created-late", "created-early"]);
  });
});

describe("orderedSidebarThreads", () => {
  const task = (threadId: string, over: Record<string, unknown> = {}) => ({
    threadId,
    title: threadId,
    busy: false,
    ...over,
  });

  it("floats attention tiers above idle threads and keeps idle stored order", () => {
    const ordered = orderedSidebarThreads([
      task("idle-a"),
      task("unread", { unread: true }),
      task("idle-b"),
      task("working", { busy: true }),
      task("idle-c"),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["working", "unread", "idle-a", "idle-b", "idle-c"]);
  });

  it("ranks waiting-on-you above working, and queued above unread", () => {
    const ordered = orderedSidebarThreads([
      task("unread", { unread: true }),
      task("queued", { queued: true }),
      task("working", { activity: "working" }),
      task("waiting", { activity: "waiting-on-you" }),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["waiting", "working", "queued", "unread"]);
  });

  it("keeps a teammate wait between working and queued even over the busy paint", () => {
    const ordered = orderedSidebarThreads([
      task("queued", { queued: true }),
      task("wait", { busy: true, activity: "working", waitingForTeammates: true }),
      task("work", { busy: true, activity: "working" }),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["work", "wait", "queued"]);
  });

  it("keeps the thread being looked at above idle threads but below attention tiers", () => {
    const ordered = orderedSidebarThreads([
      task("idle"),
      task("active"),
      task("waiting", { activity: "waiting-on-you" }),
    ], "active");
    expect(ordered.map((t) => t.threadId)).toEqual(["waiting", "active", "idle"]);
  });

  it("is stable within a tier", () => {
    const ordered = orderedSidebarThreads([
      task("unread-b", { unread: true }),
      task("unread-a", { unread: true }),
    ], "none");
    expect(ordered.map((t) => t.threadId)).toEqual(["unread-b", "unread-a"]);
  });
});
