import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { SavedCommands } from "../laterdog/slash-commands.ts";
import { requiredScope } from "../request-auth.ts";
import { createSlashCommandRoutes, SAVED_COMMANDS_PATH } from "./slash-commands.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve() {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "slash-routes-"));
  dirs.push(dir);
  const routes = [createSlashCommandRoutes({
    saved: new SavedCommands(dir, () => 5),
    tricks: (botId) => (botId === "pepper" ? [{ name: "deploy-site", description: "Ship the site." }] : null),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

describe("the person's commands over HTTP", () => {
  it("saves, renames, rewrites and deletes a command for every dog", async () => {
    const call = await serve();
    expect(await call("POST", SAVED_COMMANDS_PATH, { name: "plan", text: "Plan first." }))
      .toEqual({ status: 201, body: { command: { name: "plan", text: "Plan first.", updatedAt: 5 } } });
    expect((await call("POST", SAVED_COMMANDS_PATH, { name: "plan", text: "Again." })).status).toBe(409);
    expect(await call("PATCH", "/api/commands/plan", { name: "plan-it", text: "Plan it first." }))
      .toEqual({ status: 200, body: { command: { name: "plan-it", text: "Plan it first.", updatedAt: 5 } } });
    expect(await call("GET", SAVED_COMMANDS_PATH)).toEqual({ status: 200, body: { commands: [{ name: "plan-it", text: "Plan it first.", updatedAt: 5 }] } });
    expect(await call("DELETE", "/api/commands/plan-it")).toEqual({ status: 200, body: { ok: true } });
    expect((await call("DELETE", "/api/commands/plan-it")).status).toBe(404);
  });

  it("lists what one dog can be told: my commands, its tricks, the standard set and compact", async () => {
    const call = await serve();
    await call("POST", SAVED_COMMANDS_PATH, { name: "plan", text: "Plan first." });
    const listed = await call("GET", "/api/bots/pepper/commands");
    expect(listed.status).toBe(200);
    const commands = listed.body.commands as Array<{ name: string; kind: string }>;
    expect(commands.slice(0, 2).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "plan", kind: "mine" },
      { name: "deploy-site", kind: "trick" },
    ]);
    expect(commands.at(-1)).toMatchObject({ name: "compact", kind: "action" });
    expect((await call("GET", "/api/bots/nobody/commands")).status).toBe(404);
  });

  it("refuses bodies it cannot use and leaves other paths alone", async () => {
    const call = await serve();
    expect((await call("POST", SAVED_COMMANDS_PATH, { name: "plan" })).status).toBe(400);
    expect((await call("POST", SAVED_COMMANDS_PATH, { name: "has space", text: "x" })).status).toBe(400);
    expect((await call("PATCH", "/api/commands/plan", {})).status).toBe(400);
    expect((await call("PUT", SAVED_COMMANDS_PATH, {})).status).toBe(405);
    expect((await call("POST", "/api/bots/pepper/commands", {})).status).toBe(405);
    expect(await call("GET", "/api/bots/pepper/messages")).toEqual({ status: 404, body: { from: "inline routes" } });
  });

  it("is for the owner only", () => {
    for (const [method, path] of [["GET", "/api/bots/pepper/commands"], ["GET", SAVED_COMMANDS_PATH], ["POST", SAVED_COMMANDS_PATH], ["PATCH", "/api/commands/plan"], ["DELETE", "/api/commands/plan"]]) {
      expect(requiredScope(method, path)).toBe("admin");
    }
  });
});
