import { describe, expect, it } from "vitest";
import { initialState, reducer, type AppState, type Bot, type Message } from "./store";

const opener = { botId: "olive", name: "Olive", at: 1 };
const olive = {
  id: "olive", threadId: "main", name: "Olive", title: "", description: "", color: "yellow", notifications: true, unread: false, busy: false,
  messages: [], activeLeafId: null, modelSelection: { instanceId: "claude", model: "m" },
  tasks: [{ threadId: "main", title: "Olive", createdAt: 0 }, { threadId: "flights", title: "Book flights", createdAt: 1, openedBy: opener }],
} as unknown as Bot;
const base: AppState = { ...initialState, bots: [olive], selectedId: "olive" };
const ask: Message = { id: "m1", role: "user", kind: "text", text: "Find flights to Tokyo.", at: 2 };
const reply: Message = { id: "m2", role: "bot", kind: "text", text: "Three options.", at: 3, parentId: "m1" };

describe("an open task in the desktop", () => {
  it("opens from the dog's chat, shows its conversation once loaded, and goes back to the dog", () => {
    const opening = reducer(base, { type: "openTask", botId: "olive", threadId: "flights" });
    expect(opening.taskView).toMatchObject({ botId: "olive", threadId: "flights", loading: true });
    const loaded = reducer(opening, { type: "taskLoaded", threadId: "flights", messages: [ask], hasMore: false, activeLeafId: "m1" });
    expect(loaded.taskView).toMatchObject({ messages: [ask], activeLeafId: "m1", loading: false });
    const back = reducer(loaded, { type: "closeTask" });
    expect(back.taskView).toBeNull();
    expect(back.selectedId).toBe("olive");
  });

  it("follows the task's replies live, while the dog's own conversation stays as it was", () => {
    const open = reducer(reducer(base, { type: "openTask", botId: "olive", threadId: "flights" }), { type: "taskLoaded", threadId: "flights", messages: [ask], hasMore: false, activeLeafId: "m1" });
    const replied = reducer(open, { type: "messageAdded", threadId: "flights", message: reply });
    expect(replied.taskView?.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(replied.taskView?.activeLeafId).toBe("m2");
    expect(replied.bots[0]!.messages).toEqual([]);
    const again = reducer(replied, { type: "messageAdded", threadId: "flights", message: reply });
    expect(again.taskView?.messages).toHaveLength(2);
    const patched = reducer(again, { type: "messagePatched", threadId: "flights", message: { ...reply, text: "Four options." } });
    expect(patched.taskView?.messages.at(-1)?.text).toBe("Four options.");
    const older: Message = { id: "m0", role: "bot", kind: "text", text: "Earlier", at: 0 };
    expect(reducer(patched, { type: "olderMessages", threadId: "flights", generation: 0, messages: [older], hasMore: false }).taskView?.messages[0]?.id).toBe("m0");
  });

  it("ignores other conversations and closes when the person picks a dog or Routines", () => {
    const open = reducer(base, { type: "openTask", botId: "olive", threadId: "flights" });
    expect(reducer(open, { type: "messageAdded", threadId: "elsewhere", message: reply }).taskView?.messages).toEqual([]);
    expect(reducer(open, { type: "select", id: "olive" })).toMatchObject({ taskView: null });
    expect(reducer(open, { type: "showRoutines" })).toMatchObject({ taskView: null });
  });
});
