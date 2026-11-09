import { describe, expect, it } from "vitest";

import { openStreamWatch, STREAM_WATCH_MAX, streamWatchSkips, updateStreamWatch, type StreamWatchClient } from "./stream-watch.ts";

const delta = (threadId: string, streamKind = "assistant_text") =>
  ({ kind: "runtime", event: { type: "content.delta", threadId, streamKind, delta: "word " } });

function watching(sessionId?: string): StreamWatchClient {
  const client: StreamWatchClient = { sessionId };
  openStreamWatch(client, new URLSearchParams("screens=off&watch=1"));
  return client;
}

describe("stream watch", () => {
  it("leaves clients that did not opt in untouched", () => {
    const client: StreamWatchClient = {};
    openStreamWatch(client, new URLSearchParams("screens=off"));
    expect(client.watchId).toBeUndefined();
    expect(streamWatchSkips(client, delta("t1"))).toBe(false);
  });

  it("drops streamed text only for chats that are not on screen", () => {
    const client = watching("s1");
    expect(client.watchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(streamWatchSkips(client, delta("t1"))).toBe(true);
    expect(streamWatchSkips(client, delta("t1", "reasoning_text"))).toBe(true);
    expect(updateStreamWatch([client], { id: client.watchId, threads: ["t1"] }, "s1")).toEqual({ ok: true, threads: ["t1"] });
    expect(streamWatchSkips(client, delta("t1"))).toBe(false);
    expect(streamWatchSkips(client, delta("t2"))).toBe(true);
  });

  it("keeps every other event, including turn edges and messages", () => {
    const client = watching();
    for (const payload of [
      { kind: "runtime", event: { type: "turn.started", threadId: "t2" } },
      { kind: "runtime", event: { type: "turn.completed", threadId: "t2" } },
      { kind: "runtime", event: { type: "item.updated", threadId: "t2" } },
      { kind: "runtime", event: { type: "content.delta", threadId: "" } },
      { kind: "runtime", event: { type: "content.delta" } },
      { kind: "message", threadId: "t2", message: { role: "bot", kind: "text" } },
      { kind: "message.patch", threadId: "t2" },
      { kind: "bot.queued" },
    ]) expect(streamWatchSkips(client, payload)).toBe(false);
  });

  it("only lets the stream's own session change it", () => {
    const client = watching("s1");
    expect(updateStreamWatch([client], { id: client.watchId, threads: ["t1"] }, "s2")).toMatchObject({ ok: false, status: 404 });
    expect(updateStreamWatch([client], { id: "nope", threads: ["t1"] }, "s1")).toMatchObject({ ok: false, status: 404 });
    expect(streamWatchSkips(client, delta("t1"))).toBe(true);
  });

  it("rejects malformed and oversized watch lists", () => {
    const client = watching();
    const id = client.watchId;
    for (const body of [null, "x", { id }, { id, threads: "t1" }, { id, threads: [1] }, { id, threads: [""] },
      { id, threads: Array.from({ length: STREAM_WATCH_MAX + 1 }, (_, i) => `t${i}`) }]) {
      expect(updateStreamWatch([client], body, undefined)).toMatchObject({ ok: false, status: 400 });
    }
    expect(updateStreamWatch([client], { id, threads: ["a", "a", "b"] }, undefined)).toEqual({ ok: true, threads: ["a", "b"] });
  });

  it("can switch the filter off and on again for a measured comparison", () => {
    const client = watching();
    expect(updateStreamWatch([client], { id: client.watchId, threads: "all" }, undefined)).toEqual({ ok: true, threads: "all" });
    expect(streamWatchSkips(client, delta("t9"))).toBe(false);
    updateStreamWatch([client], { id: client.watchId, threads: [] }, undefined);
    expect(streamWatchSkips(client, delta("t9"))).toBe(true);
  });

  it("cuts a 12-dog burst on home to zero streamed words", () => {
    const client = watching();
    let sent = 0;
    for (let tick = 0; tick < 250; tick++) {
      for (let dog = 0; dog < 12; dog++) if (!streamWatchSkips(client, delta(`t${dog}`))) sent++;
    }
    expect(sent).toBe(0);
    updateStreamWatch([client], { id: client.watchId, threads: ["t3"] }, undefined);
    sent = 0;
    for (let tick = 0; tick < 250; tick++) {
      for (let dog = 0; dog < 12; dog++) if (!streamWatchSkips(client, delta(`t${dog}`))) sent++;
    }
    expect(sent).toBe(250);
  });
});
