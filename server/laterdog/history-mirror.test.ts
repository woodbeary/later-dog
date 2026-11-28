import { describe, expect, it } from "vitest";
import { HistoryMirror, HISTORY_ROUTE, MAX_MESSAGE_BYTES } from "./history-mirror.ts";

function setup(answers: number[] = []) {
  const sent: Array<{ ids: string[] }> = [];
  const local = new Map<string, { id: string; at: number; json: string }>();
  const fakeFetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://home${HISTORY_ROUTE}`);
    const status = answers.shift() ?? 200;
    if (status !== 200) return new Response("{}", { status });
    sent.push({ ids: (JSON.parse(String(init.body)).messages as Array<{ id: string }>).map((row) => row.id) });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const mirror = new HistoryMirror({
    origin: "https://home", home: "hfeed", bootstrapSecret: "s", fetch: fakeFetch,
    read: (_threadId, ids) => ids.flatMap((id) => local.get(id) ?? []),
    ownerOf: (threadId) => (threadId === "gone" ? null : "dog"),
  });
  return { mirror, sent, local };
}

describe("history mirror", () => {
  it("sends nothing while off", async () => {
    const { mirror, sent, local } = setup();
    local.set("m1", { id: "m1", at: 1, json: "{}" });
    mirror.wrote("c", "m1");
    await mirror.idle();
    expect(sent).toEqual([]);
  });

  it("sends each written message once per flush, latest copy, and skips oversized ones", async () => {
    const { mirror, sent, local } = setup();
    mirror.enabled = true;
    local.set("m1", { id: "m1", at: 1, json: "{}" });
    local.set("big", { id: "big", at: 2, json: "x".repeat(MAX_MESSAGE_BYTES + 1) });
    mirror.wrote("c", "m1");
    mirror.wrote("c", "m1");
    mirror.wrote("c", "big");
    mirror.wrote("gone", "m1");
    await mirror.idle();
    expect(sent).toEqual([{ ids: ["m1"] }]);
    expect(mirror.state).toMatchObject({ sent: 1, skipped: 1 });
    expect(mirror.pending()).toBe(0);
  });

  it("keeps what failed and sends it on the next try", async () => {
    const { mirror, sent, local } = setup([503]);
    mirror.enabled = true;
    local.set("m1", { id: "m1", at: 1, json: "{}" });
    mirror.wrote("c", "m1");
    await mirror.idle();
    expect(mirror.state.failures).toBe(1);
    expect(sent).toEqual([{ ids: ["m1"] }]);
  });
});
