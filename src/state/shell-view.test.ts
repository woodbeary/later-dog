import { describe, expect, it } from "vitest";
import { initialState, type AppState, type Bot, type Group } from "@/state/store";
import { sameFields } from "@/state/store-selectors";
import { shellView, unreadChats } from "@/state/shell-view";

const dog = (id: string, patch: Partial<Bot> = {}): Bot => ({
  id,
  threadId: `thread-${id}`,
  name: id,
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...patch,
});

const home: AppState = { ...initialState, bots: [dog("pepper"), dog("scout"), dog("biscuit", { hidden: true })], selectedId: "pepper", connected: true, hydrated: true };

const withDog = (state: AppState, id: string, patch: Partial<Bot>): AppState => ({
  ...state,
  bots: state.bots.map((bot) => (bot.id === id ? { ...bot, ...patch } : bot)),
});

describe("the shell's view of the store", () => {
  it("stays the same while another dog works, replies and turns unread", () => {
    const before = shellView(home, null);
    const working = withDog(home, "scout", { busy: true, activity: "working" });
    const replied = withDog(working, "scout", { busy: false, activity: undefined, unread: true, messages: [{ id: "m1", role: "bot", kind: "text", at: 1, text: "Done." }] });
    expect(sameFields(before, shellView(working, null))).toBe(true);
    expect(sameFields(before, shellView(replied, null))).toBe(true);
  });

  it("changes when another chat is opened", () => {
    expect(sameFields(shellView(home, null), shellView({ ...home, selectedId: "scout" }, null))).toBe(false);
  });
});

describe("unreadChats", () => {
  it("counts dogs and group chats with something unread, and leaves out hidden dogs and one-to-one rooms", () => {
    const room = (id: string, patch: Partial<Group>): Group => ({ id, threadId: `thread-${id}`, name: id, memberIds: [], messages: [], ...patch } as Group);
    expect(unreadChats(home)).toBe(0);
    const some = withDog(withDog(home, "scout", { unread: true }), "biscuit", { unread: true });
    expect(unreadChats(some)).toBe(1);
    expect(unreadChats({ ...some, groups: [room("pack", { unread: true }), room("pair", { unread: true, dm: true }), room("quiet", {})] })).toBe(2);
  });
});
