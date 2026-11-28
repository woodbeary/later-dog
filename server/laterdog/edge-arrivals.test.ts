import { describe, expect, it } from "vitest";
import { ADMISSION_ROUTE, EdgeArrivals, type Arrival } from "./edge-arrivals.ts";

function coordinator(arrivals: Arrival[]) {
  const calls: Array<Record<string, unknown>> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://home${ADMISSION_ROUTE}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push(body);
    if (body.op === "take") return Response.json({ ok: true, arrivals: arrivals.splice(0) });
    return Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const arrival = (id: string, chat = "c1"): Arrival => ({ id, dog: "d1", chat, session: "s1", body: { text: id, threadId: chat, sendId: id }, at: 1 });

describe("edge arrivals", () => {
  it("delivers each arrival in order, confirms delivered and refused ones, and keeps failed ones for another try", async () => {
    const fake = coordinator([arrival("a"), arrival("b"), arrival("c")]);
    const delivered: string[] = [];
    const refused: string[] = [];
    const edge = new EdgeArrivals({
      origin: "https://home", home: "hfeed", bootstrapSecret: "s", fetch: fake.fetch,
      sessions: () => [], dogs: () => ["d1"], log: () => {},
      deliver: async (item) => {
        if (item.id === "c") throw new Error("home busy");
        delivered.push(item.id);
        return item.id === "b" ? { status: 409, body: { error: "the dog switched tasks" } } : { status: 202, body: {} };
      },
      undelivered: (item, why) => refused.push(`${item.id}: ${why}`),
    });
    expect(await edge.pollOnce()).toBe(3);
    expect(delivered).toEqual(["a", "b"]);
    expect(refused).toEqual(["b: the dog switched tasks"]);
    expect(fake.calls.at(-1)).toEqual({ op: "done", ids: ["a", "b"] });
    expect(edge.state).toMatchObject({ taken: 3, delivered: 1, refused: 1, failures: 1 });
  });

  it("sends the owner sessions only while some dog is on the edge", async () => {
    const fake = coordinator([]);
    let dogs = ["*"];
    const edge = new EdgeArrivals({
      origin: "https://home", home: "hfeed", bootstrapSecret: "s", fetch: fake.fetch,
      sessions: () => [{ hash: "a".repeat(64), id: "s1", scopes: ["admin"], expiresAt: 9 }], dogs: () => dogs,
      deliver: async () => ({ status: 202, body: {} }), undelivered: () => {},
    });
    await edge.configure();
    edge.stop();
    dogs = [];
    await edge.configure();
    expect(fake.calls.filter((call) => call.op === "configure")).toEqual([
      { op: "configure", config: { dogs: ["*"], sessions: [{ hash: "a".repeat(64), id: "s1", scopes: ["admin"], expiresAt: 9 }] } },
      { op: "configure", config: { dogs: [], sessions: [] } },
    ]);
  });
});
