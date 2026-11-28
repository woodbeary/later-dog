import { createServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { inProcessProxy, servedInProcess } from "./in-process-proxies.ts";

const TOKEN = "chat-capability";
let stub: Server;
let port = 0;
const seen: { url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/internal/agents")) return void res.end(JSON.stringify({ bots: [{ id: "bot-helper", name: "Helper ünïcode", model: "m", busy: false }] }));
    if (req.url === "/api/internal/computer/mcp") return void res.end(JSON.stringify({ result: { tools: [{ name: "screenshot" }] } }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  port = (stub.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));

function served(spec = { command: process.execPath, args: [SPAWNED_PROXIES.agents] }, extra: Record<string, string> = {}) {
  const out: Buffer[] = [];
  const exits: number[] = [];
  const env = { LATERDOG_HARNESS_URL: `http://127.0.0.1:${port}`, LATERDOG_COMMS_TOKEN: TOKEN, LATERDOG_BOT_ID: "bot-asker", LATERDOG_THREAD_ID: "thread-asker", ...extra };
  const proxy = inProcessProxy(spec, env, (bytes) => out.push(bytes), (code) => exits.push(code))!;
  const replies = () => Buffer.concat(out).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const reply = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      const found = replies().find((msg) => msg.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no reply ${id}`);
  };
  return { proxy, exits, replies, reply };
}

describe("agents tools served in the home process", () => {
  it("serves the agents and permission launches and spawns every other server", () => {
    expect(servedInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.agents] })).toBe(true);
    expect(servedInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.permission, "/tmp/s.sock"] })).toBe(true);
    expect(servedInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.mcpGate, SPAWNED_PROXIES.agents] })).toBe(false);
    expect(servedInProcess({ command: "npx", args: ["some-server"] })).toBe(false);
    expect(servedInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "computer"] })).toBe(true);
    expect(servedInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "browser"] })).toBe(true);
    expect(servedInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "desktop"] })).toBe(false);
  });

  it("serves a pool engine's cloud computer tools without starting a process on the home", async () => {
    const { proxy, exits, reply } = served({ command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "computer"] }, { LATERDOG_MCP_TOKEN: "computer-capability" });
    proxy.write(Buffer.from([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((frame) => JSON.stringify(frame)).join("\n") + "\n"));
    expect((await reply(1)).result.serverInfo.name).toBe("laterdog-computer");
    expect((await reply(2)).result.tools).toEqual([{ name: "screenshot" }]);
    expect(seen.some((call) => call.url === "/api/internal/computer/mcp" && call.auth === "Bearer computer-capability")).toBe(true);
    proxy.end();
    expect(exits).toEqual([0]);
  });

  it("asks the chat's permission broker over its socket and answers the engine", async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), "mx-")), "b.sock");
    const asks: any[] = [];
    const broker = createSocketServer((conn) => {
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          const ask = JSON.parse(line);
          asks.push(ask);
          conn.write(JSON.stringify({ t: "answer", id: ask.id, behavior: "allow" }) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => broker.listen(socketPath, resolve));
    const { proxy, exits, reply } = served({ command: process.execPath, args: [SPAWNED_PROXIES.permission, socketPath] });
    proxy.write(Buffer.from([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" }, tool_use_id: "tu-1" } } },
    ].map((frame) => JSON.stringify(frame)).join("\n") + "\n"));
    const listed = await reply(1);
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain("approve");
    expect(JSON.parse((await reply(2)).result.content[0].text)).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    expect(asks).toMatchObject([{ t: "ask", tool: "Bash", tool_use_id: "tu-1" }]);
    proxy.end();
    expect(exits).toEqual([0]);
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it("denies when the broker is gone instead of hanging", async () => {
    const { proxy, reply } = served({ command: process.execPath, args: [SPAWNED_PROXIES.permission, join(tmpdir(), "mx-missing.sock")] });
    proxy.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "approve", arguments: { tool_name: "Bash", input: {} } } }) + "\n"));
    expect(JSON.parse((await reply(5)).result.content[0].text).behavior).toBe("deny");
    proxy.kill();
  });

  it("exits with an error when the launch cannot start", async () => {
    const { exits } = served({ command: process.execPath, args: [SPAWNED_PROXIES.permission, "/tmp/x.sock"] }, { LATERDOG_PERMISSION_TOOL_SCOPE: "[1]" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exits).toEqual([1]);
  });

  it("answers MCP frames split at any byte and calls the home with the chat's capability", async () => {
    const { proxy, exits, reply } = served();
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_bots", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "no_such_tool", arguments: {} } },
    ];
    const bytes = Buffer.from(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
    for (let at = 0; at < bytes.length; at += 7) proxy.write(bytes.subarray(at, at + 7));
    expect((await reply(1)).result.serverInfo.name).toBe("laterdog-agents");
    expect((await reply(2)).result.tools.some((tool: { name: string }) => tool.name === "list_bots")).toBe(true);
    const listed = await reply(3);
    expect(listed.result.isError).toBeFalsy();
    expect(listed.result.content[0].text).toContain("Helper ünïcode");
    expect(seen.some((call) => call.url.startsWith("/api/internal/agents") && call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect((await reply(4)).error.code).toBe(-32602);
    proxy.end();
    expect(exits).toEqual([0]);
  });

  it("stops answering once the engine closes it", async () => {
    const { proxy, exits, replies } = served();
    proxy.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_bots", arguments: {} } }) + "\n"));
    proxy.kill();
    proxy.write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" }) + "\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(replies()).toEqual([]);
    expect(exits).toEqual([1]);
  });
});
