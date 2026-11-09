import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { remoteEngineBots, remoteEngineChoice, setRemoteEngineBot } from "../laterdog/engine-placement.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createEnginePlacementRoutes } from "./engine-placement.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

async function serve(auth: RequestAuth = OWNER, env: NodeJS.ProcessEnv = {}) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-placement-route-")));
  scratch.push(dataDir);
  const routes = [createEnginePlacementRoutes({
    botExists: (id) => id === "patch" || id === "nimbus",
    read: (id) => remoteEngineChoice(dataDir, id, env),
    save: (id, computer) => setRemoteEngineBot(dataDir, id, computer, env),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (bot: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}/api/bots/${bot}/engine-placement`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { dataDir, call, file: join(dataDir, "remote-engines.json") };
}

describe("/api/bots/:id/engine-placement", () => {
  it("needs the owner's admin scope", () => {
    expect(requiredScope("GET", "/api/bots/patch/engine-placement")).toBe("admin");
    expect(requiredScope("PUT", "/api/bots/patch/engine-placement")).toBe("admin");
  });

  it("reads and saves where a dog's Claude engine runs, in the data folder the engine reads", async () => {
    const { call, dataDir, file } = await serve();
    expect(await call("patch")).toEqual({ status: 200, body: { botId: "patch", placement: "home", fromEnvironment: false, engines: ["claude"] } });
    expect(await call("patch", "PUT", { placement: "computer" })).toMatchObject({ status: 200, body: { placement: "computer" } });
    expect(await call("nimbus", "PUT", { placement: "computer" })).toMatchObject({ status: 200 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bots: ["patch", "nimbus"] });
    expect([...remoteEngineBots(dataDir, {})]).toEqual(["patch", "nimbus"]);
    expect(await call("patch")).toMatchObject({ body: { placement: "computer" } });
    expect(await call("patch", "PUT", { placement: "home" })).toMatchObject({ status: 200, body: { placement: "home" } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bots: ["nimbus"] });
  });

  it("refuses anyone but the owner, unknown dogs and malformed choices, and changes nothing", async () => {
    const client: RequestAuth = { kind: "loopback", scopes: ["client"] };
    const dog: RequestAuth = { kind: "loopback", scopes: ["admin", "client"], localTools: true };
    for (const auth of [client, dog]) {
      const { call, file } = await serve(auth);
      expect((await call("patch", "PUT", { placement: "computer" })).status).toBe(403);
      expect((await call("patch")).status).toBe(403);
      expect(() => readFileSync(file)).toThrow();
    }
    const { call, file } = await serve();
    expect((await call("ghost", "PUT", { placement: "computer" })).status).toBe(404);
    expect((await call("patch", "PUT", { placement: "cloud" })).status).toBe(400);
    expect((await call("patch", "PUT", { placement: "computer", extra: true })).status).toBe(400);
    expect((await call("patch", "DELETE")).status).toBe(405);
    expect(() => readFileSync(file)).toThrow();
    writeFileSync(file, "{broken");
    expect(await call("patch", "PUT", { placement: "computer" })).toMatchObject({ status: 500, body: { error: expect.stringContaining("left unchanged") } });
    expect(readFileSync(file, "utf8")).toBe("{broken");
  });

  it("says when the home's environment places the dog, and will not pretend to move it back", async () => {
    const { call } = await serve(OWNER, { LATERDOG_REMOTE_ENGINE_BOTS: "patch" });
    expect(await call("patch")).toMatchObject({ body: { placement: "computer", fromEnvironment: true } });
    expect((await call("patch", "PUT", { placement: "home" })).status).toBe(409);
    expect((await call("patch", "PUT", { placement: "computer" })).status).toBe(200);
  });
});
