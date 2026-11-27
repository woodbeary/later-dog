import { describe, expect, it } from "vitest";
import { fetchThroughRestart } from "../src/connect-retry.ts";

function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

const refused = () => new Response("Error proxying request to container abc: connect ECONNREFUSED", { status: 500 });

describe("a request that reaches the home while its server code is switching", () => {
  it("waits through the moment the home's port is closed and answers once it opens again", async () => {
    const time = clock();
    let tries = 0;
    const response = await fetchThroughRestart(async () => (++tries < 4 ? refused() : new Response("ok")), new Request("https://home.test/api/bots?messages=0"), time);
    expect(await response.text()).toBe("ok");
    expect(tries).toBe(4);
    expect(time.now()).toBe(750);
  });

  it("gives up after its time is spent and returns the last refusal", async () => {
    const time = clock();
    let tries = 0;
    const response = await fetchThroughRestart(async () => { tries += 1; return refused(); }, new Request("https://home.test/api/health"), { ...time, waitMs: 1_000, everyMs: 250 });
    expect(response.status).toBe(500);
    expect(tries).toBe(5);
  });

  it("never sends a write twice", async () => {
    let tries = 0;
    const response = await fetchThroughRestart(async () => { tries += 1; return refused(); }, new Request("https://home.test/api/bots/a/messages", { method: "POST", body: "{}" }), clock());
    expect(response.status).toBe(500);
    expect(tries).toBe(1);
  });

  it("passes the home's own errors straight through", async () => {
    let tries = 0;
    const response = await fetchThroughRestart(async () => { tries += 1; return new Response("boom", { status: 500 }); }, new Request("https://home.test/api/health"), clock());
    expect(await response.text()).toBe("boom");
    expect(tries).toBe(1);
  });
});
