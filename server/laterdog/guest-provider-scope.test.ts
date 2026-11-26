import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import type { SendTurnInput } from "../contracts.ts";
import { guestProviderPlan } from "./guest-provider-plan.ts";

const profile = { input: { instanceId: "fixture", displayName: "Fixture", enabled: true, config: {}, environment: {} } };
const opener = { proxyPath: "/engine/proxy", guestProvider: { entry: "/engine/guest", proxy: "/engine/proxy" }, open: async () => { throw new Error("unexpected open"); } };
const upstream = `
require("node:readline").createInterface({input:process.stdin}).on("line", line => {
  const request = JSON.parse(line);
  const result = request.method === "tools/list" ? { tools: ["lookup", "update"].map(name => ({ name, inputSchema: { type: "object" } })) }
    : { content: [{ type: "text", text: request.params.name + "-" + process.env.SELECTED }] };
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:request.id,result})+"\\n");
});`;
const spec = { command: process.execPath, args: ["-e", upstream], env: { SELECTED: "home-fixture" } };

it("holds upstream credentials on the home and enforces the selected tool on the home process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ld-scoped-"));
  try {
    const turn: SendTurnInput = { botId: "dog", threadId: "thread", sourceMessageId: "message", text: "look up",
      toolScope: { allow: ["native:*", "mcp:agents:lookup", "mcp:computer:lookup", "mcp:custom:lookup"] },
      integrations: { agents: spec, browser: spec, localComputer: { ...spec, scope: "local-computer" },
        custom: { agents: spec, custom: spec, unused: { type: "http", url: "https://example.invalid", headers: {} } } } };
    const prepared = guestProviderPlan(dir, "grokAgent", profile, turn, opener);
    const home = prepared.plan.launch.mcp;
    expect(Object.keys(home).sort()).toEqual(["agents", "custom-1", "localComputer"]);
    expect(home["custom-1"].env?.LATERDOG_GATE_NAME).toBe("custom");
    expect(home.localComputer.env?.LATERDOG_GATE_NAME).toBe("computer");
    expect(prepared.turn.integrations.localComputer?.scope).toBe("local-computer");
    expect(prepared.turn.integrations.browser).toBeUndefined();
    expect(Object.keys(prepared.turn.integrations.custom!)).toEqual(["custom"]);
    expect(JSON.stringify(prepared.turn)).not.toContain("home-fixture");
    const gate = spawn(home.agents.command, home.agents.args, { env: { ...prepared.plan.launch.proxyEnv, ...home.agents.env }, stdio: ["pipe", "pipe", "inherit"] });
    const responses = createInterface({ input: gate.stdout })[Symbol.asyncIterator]();
    const request = async (id: number, method: string, params?: { name: string }) => {
      gate.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      const line = await responses.next();
      if (line.done) throw new Error("the selected gate closed");
      return JSON.parse(line.value);
    };
    try {
      expect((await request(1, "tools/list")).result.tools.map((tool: { name: string }) => tool.name)).toEqual(["lookup"]);
      expect((await request(2, "tools/call", { name: "lookup" })).result.content[0].text).toBe("lookup-home-fixture");
      expect((await request(3, "tools/call", { name: "update" })).error).toBeDefined();
    } finally { gate.stdin.end(); gate.kill(); }
    expect(() => guestProviderPlan(dir, "grokAgent", profile, { ...turn, toolScope: { allow: ["invalid"] } }, opener)).toThrow("Tool selection");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
