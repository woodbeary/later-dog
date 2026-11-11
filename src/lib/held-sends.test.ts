import { describe, expect, it } from "vitest";
import { heldSendsAnswer, withDropped } from "../../deploy/laterdog/home/src/desk.ts";
import { HELD_GIVE_UP_MS, HELD_SENDS_KEY, heldAnswer, readHeldSends, sortHeldSends, writeHeldSends, type HeldSend } from "./held-sends";

const send = (sendId: string, at = 0): HeldSend => ({ sendId, threadId: "thread", draftId: "bot:bot:thread", text: "hi", requestText: "hi", at });
const queued = (id: string) => ({ id, path: "/api/bots/rex/messages", headers: {}, body: "{}", at: 0 });

describe("held sends kept on the device", () => {
  it("reads what the edge really answers", async () => {
    const dropped = withDropped([], [queued("send-0000000000002")], "expired", 9);
    const body = await heldSendsAnswer([queued("send-0000000000001")], dropped, ["send-0000000000001", "send-0000000000002", "send-0000000000003"]).json();
    const answer = heldAnswer(body)!;
    expect([...answer.held]).toEqual(["send-0000000000001"]);
    expect([...answer.dropped]).toEqual(["send-0000000000002"]);
    const sorted = sortHeldSends([send("send-0000000000001"), send("send-0000000000002"), send("send-0000000000003")], answer, 10);
    expect(sorted.keep.map((held) => held.sendId)).toEqual(["send-0000000000001"]);
    expect(sorted.lost.map((held) => held.sendId)).toEqual(["send-0000000000002"]);
  });

  it("believes held over dropped when one id is in both lists, as after a send again", () => {
    const answer = heldAnswer({ held: ["send-0000000000001"], dropped: [{ id: "send-0000000000001", why: "refused", at: 3 }, { id: "send-0000000000002", why: "expired", at: 4 }] })!;
    const sorted = sortHeldSends([send("send-0000000000001"), send("send-0000000000002")], answer, 10);
    expect(sorted.keep.map((held) => held.sendId)).toEqual(["send-0000000000001"]);
    expect(sorted.lost.map((held) => held.sendId)).toEqual(["send-0000000000002"]);
  });

  it("takes an answer that is not the edge's as no answer", () => {
    expect(heldAnswer({ error: "not found" })).toBeNull();
    expect(heldAnswer(null)).toBeNull();
    expect(heldAnswer({ held: "all", dropped: [] })).toBeNull();
  });

  it("without an answer, keeps a send for as long as the edge would and then calls it lost", () => {
    const young = send("send-0000000000001", 1_000);
    expect(sortHeldSends([young], null, 1_000 + HELD_GIVE_UP_MS - 1)).toEqual({ keep: [young], lost: [] });
    expect(sortHeldSends([young], null, 1_000 + HELD_GIVE_UP_MS)).toEqual({ keep: [], lost: [young] });
  });

  it("survives a reload and ignores entries it cannot read", () => {
    const values = new Map<string, string>();
    const store = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    writeHeldSends(store, [send("send-0000000000001", 4)]);
    expect(readHeldSends(store)).toEqual([send("send-0000000000001", 4)]);
    values.set(HELD_SENDS_KEY, JSON.stringify([{ sendId: 7 }, send("send-0000000000002", 5)]));
    expect(readHeldSends(store).map((held) => held.sendId)).toEqual(["send-0000000000002"]);
    values.set(HELD_SENDS_KEY, "not json");
    expect(readHeldSends(store)).toEqual([]);
    writeHeldSends(store, []);
    expect(values.has(HELD_SENDS_KEY)).toBe(false);
  });
});
