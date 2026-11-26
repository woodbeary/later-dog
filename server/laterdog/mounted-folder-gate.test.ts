import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMountedFolderGate, MountedFolderStalled } from "./mounted-folder-gate.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const never = () => new Promise<never>(() => {});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("asking a mounted working folder before touching it", () => {
  it("lets a folder that answers through at once", async () => {
    const gate = createMountedFolderGate({ probe: async () => ({}), active: () => true });
    await expect(gate.require("/data/.laterdog/workspaces/a")).resolves.toBeUndefined();
  });

  it("refuses a folder that answers with an error only by passing it on, since the error comes back at once", async () => {
    const gate = createMountedFolderGate({ probe: async () => { throw Object.assign(new Error("io"), { code: "EIO" }); }, active: () => true });
    await expect(gate.answers("/data/.laterdog/workspaces/a")).resolves.toBe(true);
  });

  it("gives up on a stalled folder after its wait, then refuses it at once while the first look is still stuck", async () => {
    let probes = 0;
    let clock = 0;
    const gate = createMountedFolderGate({ probe: () => { probes += 1; return never(); }, answerMs: 30, recheckMs: 1_000, now: () => clock, active: () => true });
    const started = Date.now();
    await expect(gate.require("/data/.laterdog/workspaces/stuck")).rejects.toBeInstanceOf(MountedFolderStalled);
    expect(Date.now() - started).toBeLessThan(1_000);
    clock = 10;
    const again = Date.now();
    await expect(gate.answers("/data/.laterdog/workspaces/stuck")).resolves.toBe(false);
    expect(Date.now() - again).toBeLessThan(25);
    expect(probes).toBe(1);
    expect((await gate.answers("/data/.laterdog/workspaces/other").catch(() => "x"))).toBe(false);
    expect(probes).toBe(2);
  });

  it("names the stall with an error code the memory routes report as a temporarily unavailable folder", () => {
    expect(new MountedFolderStalled("/x").code).toBe("ETIMEDOUT");
  });

  it("keeps health answering while a request for a stalled dog's folder waits and then fails", async () => {
    const gate = createMountedFolderGate({ probe: never, answerMs: 300, active: () => true });
    const url = await listen(createServer(async (request, response) => {
      if (request.url === "/api/health") return void response.end("ok");
      try {
        await gate.require("/data/.laterdog/workspaces/stalled");
        response.end("read");
      } catch (error) {
        response.writeHead(503).end((error as MountedFolderStalled).code);
      }
    }));
    const memory = fetch(`${url}/api/bots/stalled/memory`);
    const healthStarted = Date.now();
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect(Date.now() - healthStarted).toBeLessThan(200);
    const reply = await memory;
    expect(reply.status).toBe(503);
    expect(await reply.text()).toBe("ETIMEDOUT");
  });

  it("does nothing outside a home with mounted working folders", async () => {
    const gate = createMountedFolderGate({ probe: never, answerMs: 10, active: () => false });
    await expect(gate.answers("/data/.laterdog/workspaces/a")).resolves.toBe(true);
  });
});
