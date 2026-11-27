import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { agentsInProcessProxy, servesAgentsInProcess } from "./agents-mcp-session.ts";

const TOKEN = "chat-capability";
let stub: Server;
let port = 0;
const seen: { url: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/api/internal/agents")) return void res.end(JSON.stringify({ bots: [{ id: "bot-helper", name: "Helper ünïcode", model: "m", busy: false }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  port = (stub.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));

function served() {
  const out: Buffer[] = [];
  const exits: number[] = [];
  const env = { LATERDOG_HARNESS_URL: `http://127.0.0.1:${port}`, LATERDOG_COMMS_TOKEN: TOKEN, LATERDOG_BOT_ID: "bot-asker", LATERDOG_THREAD_ID: "thread-asker" };
  const proxy = agentsInProcessProxy(env, (bytes) => out.push(bytes), (code) => exits.push(code));
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
  it("recognises only the agents proxy launch", () => {
    expect(servesAgentsInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.agents] })).toBe(true);
    expect(servesAgentsInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.permission, "/tmp/s.sock"] })).toBe(false);
    expect(servesAgentsInProcess({ command: process.execPath, args: [SPAWNED_PROXIES.mcpGate, SPAWNED_PROXIES.agents] })).toBe(false);
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
