import { describe, expect, it } from "vitest";
import { personIsLooking, readWhenBack } from "./viewing";

const glance = (focused: boolean, visibilityState: DocumentVisibilityState = "visible") => ({ hasFocus: () => focused, visibilityState });

const pepper = (unread: boolean) => ({
  id: "pepper",
  threadId: "pepper-b",
  tasks: [{ threadId: "pepper-a", unread: true }, { threadId: "pepper-b", unread }],
});

describe("finished work the person has not looked at yet", () => {
  it("counts as seen only while the window is focused and visible", () => {
    expect(personIsLooking(glance(true))).toBe(true);
    expect(personIsLooking(glance(false))).toBe(false);
    expect(personIsLooking(glance(true, "hidden"))).toBe(false);
  });

  it("is marked read once the person comes back to the open chat", () => {
    expect(readWhenBack({ selectedId: "pepper", activeView: "chat", bots: [pepper(true)], groups: [] })).toEqual({
      path: "/api/bots/pepper/read",
      body: JSON.stringify({ threadId: "pepper-b" }),
    });
    expect(readWhenBack({ selectedId: "room", activeView: "chat", bots: [], groups: [{ id: "room", unread: true }] })).toEqual({
      path: "/api/groups/room/read",
    });
  });

  it("stays unread when the open chat is not the one with news", () => {
    expect(readWhenBack({ selectedId: "pepper", activeView: "chat", bots: [pepper(false)], groups: [] })).toBeNull();
    expect(readWhenBack({ selectedId: "pepper", activeView: "routines", bots: [pepper(true)], groups: [] })).toBeNull();
    expect(readWhenBack({ selectedId: null, activeView: "chat", bots: [pepper(true)], groups: [] })).toBeNull();
    expect(readWhenBack({ selectedId: "room", activeView: "chat", bots: [], groups: [{ id: "room", unread: false }] })).toBeNull();
  });
});
