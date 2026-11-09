import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { remoteEngineBots, remoteEngineChoice, setRemoteEngineBot } from "../laterdog/engine-placement.ts";
import { beginOwnership, pointerPaths, readPointer, savePointer } from "../laterdog/engine-pointer.ts";
import type { EngineLink } from "../laterdog/engine-remote.ts";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
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

async function serve(auth: RequestAuth = OWNER, env: NodeJS.ProcessEnv = {}, relay: (botId: string) => Promise<EngineLink> = async () => { throw new Error("the cloud computer did not wake"); }) {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-placement-route-")));
  scratch.push(dataDir);
  const routes = [createEnginePlacementRoutes({
    botExists: (id) => id === "patch" || id === "nimbus",
    read: (id) => remoteEngineChoice(dataDir, id, env),
    save: (id, computer) => setRemoteEngineBot(dataDir, id, computer, env),
    workspaces: { dataDir, relay },
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
  const raw = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);
  return { dataDir, call, raw, file: join(dataDir, "remote-engines.json") };
}

describe("/api/bots/:id/engine-placement", () => {
  it("needs the owner's admin scope", () => {
    expect(requiredScope("GET", "/api/bots/patch/engine-placement")).toBe("admin");
    expect(requiredScope("PUT", "/api/bots/patch/engine-placement")).toBe("admin");
  });

  it("reads and saves where a dog's Claude engine runs, in the data folder the engine reads", async () => {
    const { call, dataDir, file } = await serve();
    expect(await call("patch")).toEqual({ status: 200, body: { botId: "patch", placement: "home", workspace: "home", heldWorkspaces: 0, fromEnvironment: false, engines: ["claude"] } });
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

  it("saves the workspace option only beside a placed engine, and leaves it alone when it is not sent", async () => {
    const { call, file } = await serve();
    expect((await call("patch", "PUT", { placement: "home", workspace: "computer" })).status).toBe(400);
    expect((await call("patch", "PUT", { placement: "computer", workspace: "disk" })).status).toBe(400);
    expect(await call("patch", "PUT", { placement: "computer", workspace: "computer" })).toMatchObject({ status: 200, body: { placement: "computer", workspace: "computer" } });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bots: ["patch"], workspaceOnComputer: ["patch"] });
    expect(await call("patch", "PUT", { placement: "computer" })).toMatchObject({ body: { workspace: "computer" } });
    expect(await call("patch", "PUT", { placement: "computer", workspace: "home" })).toMatchObject({ status: 200, body: { workspace: "home" } });
  });
});

describe("/api/bots/:id/engine-workspaces", () => {
  const cwd = "/srv/task-workspaces/one";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  function held(dataDir: string) {
    const pointer = beginOwnership(dataDir, "patch", cwd, 1_000);
    const paths = pointerPaths(dataDir, "patch", cwd);
    mkdirSync(paths.artifacts, { recursive: true });
    writeFileSync(join(paths.artifacts, "report.md"), "saved report");
    savePointer(dataDir, { ...pointer, seeded: true, writtenAt: 2_000, artifacts: [{ path: "report.md", hash: sha("saved report"), size: 12 }],
      manifest: { at: 2_000, files: [{ path: "report.md", size: 12, hash: sha("saved report"), mtimeMs: 1 }, { path: "big.bin", size: 9e9, hash: "e".repeat(64), mtimeMs: 1 }], totalFiles: 2, totalBytes: 9e9 + 12, truncated: false, git: null } });
  }

  it("refuses to move a dog's engine or workspace home while the computer holds its work", async () => {
    const { call, dataDir } = await serve();
    await call("patch", "PUT", { placement: "computer", workspace: "computer" });
    held(dataDir);
    expect(await call("patch")).toMatchObject({ body: { heldWorkspaces: 1 } });
    expect(await call("patch", "PUT", { placement: "home" })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/Bring them home first/) } });
    expect((await call("patch", "PUT", { placement: "computer", workspace: "home" })).status).toBe(409);
  });

  it("lists bounded pointers and serves a file from a saved copy that matches the manifest when the computer cannot wake", async () => {
    const { raw, dataDir } = await serve();
    held(dataDir);
    const listed = await (await raw("/api/bots/patch/engine-workspaces")).json() as { workspaces: Array<Record<string, unknown>> };
    expect(listed.workspaces).toEqual([expect.objectContaining({ cwd, state: "held", seeded: true, files: 2, listed: 2, artifacts: { files: 1, bytes: 12 } })]);
    const read = await raw(`/api/bots/patch/engine-workspaces/file?cwd=${encodeURIComponent(cwd)}&path=report.md`);
    expect(read.status).toBe(200);
    expect(read.headers.get("x-laterdog-workspace-source")).toBe("artifact");
    expect(decodeURIComponent(read.headers.get("x-laterdog-workspace-note")!)).toMatch(/could not be reached \(the cloud computer did not wake\)/);
    expect(await read.text()).toBe("saved report");
    const onlyThere = await raw(`/api/bots/patch/engine-workspaces/file?cwd=${encodeURIComponent(cwd)}&path=big.bin`);
    expect(onlyThere.status).toBe(503);
    expect((await raw(`/api/bots/patch/engine-workspaces/file?cwd=/elsewhere&path=report.md`)).status).toBe(404);
    expect((await raw("/api/bots/ghost/engine-workspaces")).status).toBe(404);
  });

  it("keeps the workspace held when bringing it home cannot reach the computer, and only the owner may ask", async () => {
    const { raw, dataDir } = await serve();
    held(dataDir);
    const brought = await raw("/api/bots/patch/engine-workspaces/home", { method: "POST", body: JSON.stringify({ cwd }) });
    expect(brought.status).toBe(503);
    expect(readPointer(dataDir, "patch", cwd)).toMatchObject({ state: "held", seeded: true });
    expect((await raw("/api/bots/patch/engine-workspaces/home", { method: "POST", body: "{}" })).status).toBe(400);
    for (const auth of [{ kind: "loopback", scopes: ["client"] }, { kind: "loopback", scopes: ["admin", "client"], localTools: true }] as RequestAuth[]) {
      const other = await serve(auth);
      held(other.dataDir);
      expect((await other.raw("/api/bots/patch/engine-workspaces")).status).toBe(403);
      expect((await other.raw("/api/bots/patch/engine-workspaces/home", { method: "POST", body: JSON.stringify({ cwd }) })).status).toBe(403);
    }
  });
});
