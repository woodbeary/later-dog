import { describe, expect, it } from "vitest";

import { restingStateForBot, stateForBot, turnState } from "./mascot";

describe("stateForBot", () => {
  it("still alerts on a failed tool call when a digest receipt follows it", () => {
    // Phase 0 writes a digest row after every turn, so the failed chip is
    // no longer the last row; the mood must read past the receipt.
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "digest" },
      ],
    })).toBe("alerting");
  });

  it("keeps reading a pending card as curious behind a receipt", () => {
    expect(stateForBot({ name: "Atlas", messages: [{ kind: "options" }, { kind: "digest" }] })).toBe("curious");
  });
});

describe("the dog's face during a turn", () => {
  const running = { kind: "activity", tool: {} };
  const ran = { kind: "activity", tool: { ok: true } };
  const failed = { kind: "activity", tool: { ok: false } };
  const askingTeammate = { kind: "activity", tool: {}, comm: { withBotId: "scout" } };
  const tails = [[running], [ran], [failed], [askingTeammate], [{ kind: "text" }], [running, { kind: "compaction" }], []];

  it("works while a tool runs and thinks otherwise, the same rule in the sidebar and the chat", () => {
    expect(tails.map((messages) => turnState(messages))).toEqual(["working", "thinking", "thinking", "thinking", "thinking", "working", "thinking"]);
    for (const messages of tails) expect(stateForBot({ name: "Atlas", busy: true, messages })).toBe(turnState(messages));
  });

  it("keeps the turn's face over a chosen face or a failed step, and keeps the chosen face once it settles", () => {
    expect(stateForBot({ name: "Atlas", busy: true, mascotExpression: "sleepy", messages: [failed] })).toBe("thinking");
    expect(stateForBot({ name: "Atlas", mascotExpression: "sleepy", messages: [failed] })).toBe("drowsy");
  });

  it("looks curious while it waits on the person", () => {
    expect(stateForBot({ name: "Atlas", busy: true, activity: "waiting-on-you", messages: [running] })).toBe("curious");
  });
});

describe("restingStateForBot", () => {
  it("keeps the dog's own face whatever the conversation is doing", () => {
    const live = { busy: true, unread: true, activity: "waiting-on-you", messages: [{ kind: "activity", tool: { ok: false } }] };
    expect(restingStateForBot({ name: "Atlas", title: "Software engineer", ...live })).toBe("working");
    expect(restingStateForBot({ name: "Atlas", ...live })).toBe("idle");
    expect(restingStateForBot({ name: "Atlas", mascotExpression: "sleepy", ...live })).toBe("drowsy");
  });
});
