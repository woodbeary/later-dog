import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { callTool, callWaitMs, type ToolCallContext } from "./agents-call.ts";
import { createHarnessClient } from "./agents-client.ts";

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function home(answer: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(answer);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const context = (url: string, signal?: AbortSignal): ToolCallContext => ({ botId: "dog", threadId: "t1", depth: 0, sharedComputers: false, client: createHarnessClient(url, "token"), ...(signal ? { signal } : {}) });

describe("a run_on_computer call that waits a long time", () => {
  it("still gets its answer when the home answers after more than five minutes", async () => {
    const url = await home((req, res) => { req.resume(); setTimeout(() => res.end(JSON.stringify({ text: "Finished on your cloud computer with exit code 0 (run_id abcd1234)." })), 310_000); });
    const result = await callTool("run_on_computer", { run_id: "abcd1234", wait_minutes: 10 }, context(url));
    expect(result).toEqual({ text: "Finished on your cloud computer with exit code 0 (run_id abcd1234).", isError: false });
  }, 400_000);

  it("hangs up on the home when the engine cancels the call, so the home stops waiting", async () => {
    let closed = false;
    const url = await home((req, res) => { req.resume(); res.on("close", () => { closed = !res.writableEnded; }); });
    const cancel = new AbortController();
    const pending = callTool("run_on_computer", { run_id: "abcd1234", wait_minutes: 30 }, context(url, cancel.signal));
    await new Promise((done) => setTimeout(done, 200));
    cancel.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await new Promise((done) => setTimeout(done, 200));
    expect(closed).toBe(true);
  });

  it("gives the call two minutes more than the wait it asked for, and the old window when it asked for none", () => {
    expect(callWaitMs(60)).toBe(62 * 60_000);
    expect(callWaitMs(undefined)).toBe(6 * 60_000);
    expect(callWaitMs("60")).toBe(6 * 60_000);
  });
});
