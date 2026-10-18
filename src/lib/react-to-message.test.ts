import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reducer, type Action, type AppState, type Bot, type Group, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { canReactTo, reactToMessage } from "./react-to-message";

const reply: Message = { id: "m1", role: "bot", kind: "text", at: 1, text: "Packed." };
const bot = { id: "pepper", threadId: "pepper-thread", name: "Pepper", messages: [reply] } as unknown as Bot;
const room = { id: "room", threadId: "room-thread", name: "Trip", memberIds: ["pepper"], messages: [reply] } as unknown as Group;

function harness() {
  let state: AppState = { ...initialState, bots: [bot], groups: [room] };
  const actions: Action[] = [];
  const dispatch = (action: Action) => {
    actions.push(action);
    state = reducer(state, action);
  };
  return {
    dispatch,
    actions,
    botMessage: () => state.bots[0]!.messages[0]!,
    botReactions: () => state.bots[0]!.messages[0]!.reactions,
    roomReactions: () => state.groups[0]!.messages[0]!.reactions,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("reacting to a message from the Mac", () => {
  it("shows the reaction at once and keeps what the server saved", async () => {
    const saved = { ...reply, reactions: [{ emoji: "👎", by: "pepper" }, { emoji: "👍", by: "user" }] };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ message: saved }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const { dispatch, botReactions } = harness();
    const pending = reactToMessage(dispatch, "pepper-thread", reply, "👍");
    expect(botReactions()).toEqual([{ emoji: "👍", by: "user" }]);
    await expect(pending).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/threads/pepper-thread/messages/m1/reactions", expect.objectContaining({ method: "POST", body: JSON.stringify({ emoji: "👍" }) }));
    expect(botReactions()).toEqual(saved.reactions);
  });

  it("takes the reaction back and says so when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no such message" }), { status: 404 })));
    const { dispatch, actions, roomReactions } = harness();
    await expect(reactToMessage(dispatch, "room-thread", reply, "🎉")).resolves.toBe(false);
    expect(roomReactions()).toBeUndefined();
    expect(actions.at(-1)).toEqual({ type: "error", message: t("chat.reaction.failed") });
  });

  it("puts back the reactions the message had when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 })));
    const { dispatch, botReactions } = harness();
    const earlier = [{ emoji: "❤️", by: "pepper" }];
    dispatch({ type: "messagePatched", threadId: "pepper-thread", message: { ...reply, reactions: earlier } });
    await expect(reactToMessage(dispatch, "pepper-thread", { ...reply, reactions: earlier }, "❤️")).resolves.toBe(false);
    expect(botReactions()).toEqual(earlier);
  });

  it("takes only the reactions from the saved copy, never older text", async () => {
    const stale = { ...reply, text: "Pack", reactions: [{ emoji: "👍", by: "user" }] };
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const { dispatch, botMessage } = harness();
    const pending = reactToMessage(dispatch, "pepper-thread", reply, "👍");
    dispatch({ type: "messagePatched", threadId: "pepper-thread", message: { ...reply, text: "Packed and labelled.", reactions: [{ emoji: "👍", by: "user" }] } });
    answer(new Response(JSON.stringify({ message: stale }), { status: 200 }));
    await expect(pending).resolves.toBe(true);
    expect(botMessage().text).toBe("Packed and labelled.");
    expect(botMessage().reactions).toEqual(stale.reactions);
  });

  it("does not react to a message that has not reached the home yet", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(canReactTo({ id: "optimistic-abc" })).toBe(false);
    const { dispatch, actions } = harness();
    await expect(reactToMessage(dispatch, "pepper-thread", { id: "optimistic-abc" }, "👍")).resolves.toBe(false);
    expect(actions).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies a reaction made on the phone when its patch arrives", () => {
    const { dispatch, roomReactions } = harness();
    dispatch({ type: "messagePatched", threadId: "room-thread", message: { ...reply, reactions: [{ emoji: "❤️", by: "user" }] } });
    expect(roomReactions()).toEqual([{ emoji: "❤️", by: "user" }]);
  });
});
