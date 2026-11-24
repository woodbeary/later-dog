import { describe, expect, it } from "vitest";
import { liveScreenAction, withLiveScreen } from "./live-screens";
import { reducer, initialState } from "@/state/store";

describe("the live Mac screen in a chat", () => {
  it("keeps the newest Mac frame for its chat", () => {
    const first = liveScreenAction({ kind: "screen", botId: "rex", threadId: "t1", png: "AAA", mime: "image/jpeg", place: "mac" }, 10);
    expect(first).toEqual({ type: "liveScreen", threadId: "t1", screen: { botId: "rex", png: "AAA", mime: "image/jpeg", at: 10 } });
    const second = liveScreenAction({ kind: "screen", botId: "rex", threadId: "t1", png: "BBB", mime: "image/jpeg", place: "mac" }, 20);
    const state = reducer(reducer(initialState, first!), second!);
    expect(state.liveScreens.t1).toEqual({ botId: "rex", png: "BBB", mime: "image/jpeg", at: 20 });
  });

  it("drops the frame when the dog lets go of the Mac", () => {
    const shown = reducer(initialState, liveScreenAction({ kind: "screen", botId: "rex", threadId: "t1", png: "AAA", place: "mac" }, 1)!);
    expect(shown.liveScreens.t1?.mime).toBe("image/jpeg");
    const ended = reducer(shown, liveScreenAction({ kind: "screen.end", botId: "rex", threadId: "t1" })!);
    expect(ended.liveScreens).toEqual({});
  });

  it("leaves cloud computer frames alone", () => {
    expect(liveScreenAction({ kind: "screen", botId: "rex", threadId: "t1", png: "AAA" })).toBeNull();
    expect(liveScreenAction({ kind: "screen", botId: "rex", threadId: "t1", png: "", place: "mac" })).toBeNull();
  });

  it("changes nothing when an unknown chat ends", () => {
    const screens = {};
    expect(withLiveScreen(screens, { type: "liveScreen", threadId: "t9", screen: null })).toBe(screens);
  });
});
