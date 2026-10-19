import { describe, expect, it } from "vitest";

import { initialState, reducer, type AppState, type Bot } from "./store";

const dog = (extra: Partial<Bot> = {}): Bot => ({
  id: "a", threadId: "t-a", name: "Atlas", title: "", description: "", color: "green", notifications: true,
  unread: true, messages: [], modelSelection: { instanceId: "test", model: "m" }, ...extra,
});

describe("sidebar actions", () => {
  it("marks a dog read without opening it", () => {
    const state: AppState = { ...initialState, selectedId: "other", bots: [dog({ tasks: [{ threadId: "t-a", title: "", createdAt: 1, unread: true }] })] };
    const next = reducer(state, { type: "markRead", botId: "a" });
    expect(next.bots[0]!.unread).toBe(false);
    expect(next.bots[0]!.tasks![0]!.unread).toBe(false);
    expect(next.selectedId).toBe("other");
  });

  it("orders sections at once and keeps any it was not told about after them", () => {
    const next = reducer({ ...initialState, sections: ["Work", "Home", "Side"] }, { type: "orderSections", sections: ["Side", "Work"] });
    expect(next.sections).toEqual(["Side", "Work", "Home"]);
  });

  it("opens and closes search", () => {
    const open = reducer(initialState, { type: "toggleSearch", open: true });
    expect(open.searchOpen).toBe(true);
    expect(reducer(open, { type: "toggleSearch" }).searchOpen).toBe(false);
  });
});
