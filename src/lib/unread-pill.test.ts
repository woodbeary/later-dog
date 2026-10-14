import { describe, expect, it } from "vitest";

import { dismissKey, unreadBelowCount, unreadCount, unreadPosition } from "./unread-pill";

const rows = [
  { id: "a", role: "user", at: 10 },
  { id: "b", role: "bot", at: 20 },
  { id: "c", role: "bot", at: 30 },
  { id: "d", role: "user", at: 40 },
  { id: "e", role: "bot", at: 50 },
];

describe("what is new since you were last here", () => {
  it("counts the dog's messages after the boundary and never your own", () => {
    expect(unreadCount(rows, 15)).toBe(3);
    expect(unreadCount(rows, 40)).toBe(1);
    expect(unreadCount(rows, 50)).toBe(0);
    expect(unreadCount(rows, null)).toBe(0);
  });

  it("counts only what sits at or below a given row", () => {
    expect(unreadBelowCount(rows, 15, "c")).toBe(2);
    expect(unreadBelowCount(rows, 15, "gone")).toBe(0);
    expect(unreadBelowCount(rows, null, "c")).toBe(0);
    expect(unreadBelowCount(rows, 15, null)).toBe(0);
  });

  it("says where the NEW divider sits against the viewport", () => {
    const view = { top: 100, bottom: 700 };
    expect(unreadPosition({ top: 20, bottom: 40 }, view)).toBe("above");
    expect(unreadPosition({ top: 90, bottom: 100 }, view)).toBe("above");
    expect(unreadPosition({ top: 300, bottom: 320 }, view)).toBe("visible");
    expect(unreadPosition({ top: 700, bottom: 720 }, view)).toBe("below");
    expect(unreadPosition(null, view)).toBe("none");
  });

  it("remembers a dismissal for one visit of one conversation only", () => {
    expect(dismissKey("bot/thread", 15)).not.toBe(dismissKey("bot/thread", 90));
    expect(dismissKey("bot/thread", 15)).not.toBe(dismissKey("bot/other", 15));
    expect(dismissKey("bot/thread", null)).toBe("bot/thread:none");
  });
});
