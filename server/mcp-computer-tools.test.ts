import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./testing/scrub-ambient-laterdog-env.ts";

import { TOOLS as WORKER_TOOLS } from "../deploy/laterdog/computers/src/mcp-tools.ts";
import { COMPUTER_TOOLS, NOT_SET_UP, callComputerTool, mcpEndpoint } from "../scripts/mcp-computer-tools.ts";
import { TOOLS, handleToolCall, processMcpMessage } from "../scripts/mcp-server.ts";
import type { ComputersConnection } from "./laterdog/cloud-computers.ts";

const KEY = `ldt_${"t".repeat(43)}`;
const OWN_KEY = "ldc_a-test-key-for-this-file-only";
const API = "https://computers.example.test/v1";
const ID = "cmp_abcdefghij23";
const ORIGINAL_FETCH = globalThis.fetch;

let home: string;
let before: string | undefined;

beforeEach(() => {
  before = process.env.LATERDOG_HOME;
  home = mkdtempSync(join(tmpdir(), "ld-mcp-computers-"));
  process.env.LATERDOG_HOME = home;
});

afterEach(() => {
  if (before === undefined) delete process.env.LATERDOG_HOME;
  else process.env.LATERDOG_HOME = before;
  rmSync(home, { recursive: true, force: true });
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const trialConnection = (): ComputersConnection => ({ api: API, keyFile: join(home, "computers-trial-key"), source: "trial" });
const ownConnection = (): ComputersConnection => ({ api: API, keyFile: join(home, "computers-key"), source: "file" });
const rpcAnswer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });
const reply = (text: string, extra: Record<string, unknown> = {}) => rpcAnswer({ content: [{ type: "text", text }], ...extra });

function sender(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(url), init: init!, body: JSON.parse(String(init!.body)) };
    calls.push(entry);
    return answer(entry.url, entry.init);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const deps = (fetcher: typeof fetch, connection = trialConnection(), key = KEY) => ({ connection: () => connection, key: () => key, fetch: fetcher });

describe("the computer tools next to the team tools", () => {
  it("come after the orchestration tools, under the same closed shape, and share the Worker's definitions", async () => {
    const listed = JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })))!).result.tools;
    expect(listed.map((tool: { name: string }) => tool.name)).toEqual([...TOOLS, ...COMPUTER_TOOLS].map((tool) => tool.name));
    expect(COMPUTER_TOOLS).toBe(WORKER_TOOLS);
    expect(new Set(listed.map((tool: { name: string }) => tool.name)).size).toBe(listed.length);
    expect(listed.every((tool: any) => tool.inputSchema.additionalProperties === false && tool.annotations)).toBe(true);
    expect(COMPUTER_TOOLS.map((tool) => tool.name)).toEqual([
      "computer_list", "computer_create", "computer_wake", "computer_sleep", "computer_screenshot", "computer_action", "computer_exec", "computer_viewer_link", "decide",
    ]);
    expect(TOOLS.map((tool) => tool.name).filter((name) => COMPUTER_TOOLS.some((other) => other.name === name))).toEqual([]);
  });
});

describe("mcpEndpoint", () => {
  it("is the service's /mcp beside its /v1", () => {
    expect(mcpEndpoint("https://cloud.later.dog/v1")).toBe("https://cloud.later.dog/mcp");
    expect(mcpEndpoint("http://127.0.0.1:8787/v1")).toBe("http://127.0.0.1:8787/mcp");
    expect(() => mcpEndpoint("https://cloud.later.dog")).toThrow("must end in /v1");
  });
});

describe("calling the Worker", () => {
  it("forwards the call as JSON-RPC with this Mac's key and returns the content untouched", async () => {
    const { fetcher, calls } = sender(() => rpcAnswer({ content: [{ type: "text", text: "Screenshot" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }], structuredContent: { a: 1 } }));
    const result = await callComputerTool("computer_screenshot", { computer_id: ID }, deps(fetcher));
    expect(result).toEqual({ content: [{ type: "text", text: "Screenshot" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }], structuredContent: { a: 1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://computers.example.test/mcp");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(calls[0]!.body).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "computer_screenshot", arguments: { computer_id: ID } } });
  });

  it("keeps a tool's own error flag", async () => {
    const { fetcher } = sender(() => reply("No computer with that id.", { isError: true }));
    expect(await callComputerTool("computer_wake", { computer_id: ID }, deps(fetcher))).toEqual({ content: [{ type: "text", text: "No computer with that id." }], isError: true });
  });

  it("says plainly when later.dog Cloud is not set up, and never calls out", async () => {
    const { fetcher } = sender(() => reply("x"));
    await expect(callComputerTool("computer_list", {}, { connection: () => null, fetch: fetcher })).rejects.toThrow(NOT_SET_UP);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("gives a computer_exec the time it asked for, plus a margin", async () => {
    const seen: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      seen.push(ms);
      return new AbortController().signal;
    });
    const { fetcher } = sender(() => reply("{}"));
    await callComputerTool("computer_exec", { computer_id: ID, command: "x", timeout_ms: 120_000 }, deps(fetcher));
    await callComputerTool("computer_list", {}, deps(fetcher));
    spy.mockRestore();
    expect(seen).toEqual([150_000, 90_000]);
  });

  it("turns each way the service can fail into plain words without the key", async () => {
    const failures: Array<[Response | (() => never), ComputersConnection, string]> = [
      [Response.json({ error: { code: "not_found", message: "No computer with that id." } }, { status: 404 }), trialConnection(), "No computer with that id."],
      [Response.json({ error: { code: "unauthorized", message: "The API key is not valid." } }, { status: 401 }), ownConnection(), `later.dog's computers service rejected the key in ${ownConnection().keyFile}`],
      [Response.json({ error: { code: "unauthorized", message: "This free trial has ended or has not started yet." } }, { status: 401 }), trialConnection(), "This free trial has ended or has not started yet."],
      [new Response("busy", { status: 429 }), trialConnection(), "later.dog's computers service is rate-limiting this Mac. Wait a minute and try again."],
      [new Response("<html>", { status: 502 }), trialConnection(), "later.dog's computers service could not complete that request (502)"],
      [Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "The body is not valid JSON." } }, { status: 400 }), trialConnection(), "The body is not valid JSON."],
      [Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "There is no tool named x." } }), trialConnection(), "There is no tool named x."],
      [new Response("not json"), trialConnection(), "later.dog's computers service answered something unexpected"],
      [rpcAnswer({ content: "text" }), trialConnection(), "later.dog's computers service answered something unexpected"],
      [rpcAnswer({ content: [{ type: "image", data: "AA", mimeType: "text/html" }] }), trialConnection(), "later.dog's computers service answered something unexpected"],
      [rpcAnswer({ content: [{ type: "resource", uri: "file:///etc/passwd" }] }), trialConnection(), "later.dog's computers service answered something unexpected"],
      [Response.json([]), trialConnection(), "later.dog's computers service answered something unexpected"],
    ];
    for (const [answer, connection, message] of failures) {
      const { fetcher } = sender(() => (typeof answer === "function" ? answer() : answer.clone()));
      const failure = await callComputerTool("computer_list", {}, deps(fetcher, connection)).then(() => null, (error: Error) => error);
      expect(failure?.message, message).toBe(message);
      expect(failure?.message).not.toContain(KEY);
    }
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(callComputerTool("computer_list", {}, deps(down))).rejects.toThrow("later.dog's computers service could not be reached");
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => { controller.abort(new DOMException("Request cancelled", "AbortError")); throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch;
    await expect(callComputerTool("computer_list", {}, deps(fetcher), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses an oversized answer", async () => {
    const { fetcher } = sender(() => new Response("x", { headers: { "content-length": String(17 * 1024 * 1024) } }));
    await expect(callComputerTool("computer_list", {}, deps(fetcher))).rejects.toThrow("answered something unexpected");
  });
});

describe("through the stdio server", () => {
  const trialFiles = () => {
    writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: API, confirmed: true, included: ["decisions"] }));
    writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`, { mode: 0o600 });
  };
  const send = async (name: string, args: unknown) =>
    JSON.parse((await processMcpMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } })))!);

  it("uses the key the installation already holds for its free trial, and nothing else", async () => {
    trialFiles();
    const { fetcher, calls } = sender(() => rpcAnswer({ content: [{ type: "text", text: "ok" }, { type: "image", data: "/9j/", mimeType: "image/jpeg" }] }));
    globalThis.fetch = fetcher;
    const response = await send("computer_screenshot", { computer_id: ID });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://computers.example.test/mcp");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(response.result.content).toEqual([{ type: "text", text: "ok" }, { type: "image", data: "/9j/", mimeType: "image/jpeg" }]);
    expect(JSON.stringify(response)).not.toContain(KEY);
  });

  it("uses the saved own-service key when the person runs their own computers", async () => {
    writeFileSync(join(home, "computers.json"), JSON.stringify({ api: API }));
    writeFileSync(join(home, "computers-key"), `${OWN_KEY}\n`, { mode: 0o600 });
    const { fetcher, calls } = sender(() => reply("ok"));
    globalThis.fetch = fetcher;
    await send("computer_list", {});
    expect(calls[0]!.init.headers).toMatchObject({ authorization: `Bearer ${OWN_KEY}` });
  });

  it("tells a Mac with no computers service what to do, as a tool error", async () => {
    const { fetcher } = sender(() => reply("never"));
    globalThis.fetch = fetcher;
    const response = await send("computer_list", {});
    expect(response.result).toEqual({ content: [{ type: "text", text: `Error: ${NOT_SET_UP}` }], isError: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a service address that would send the key in the clear", async () => {
    writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "http://computers.example.test/v1", confirmed: true }));
    writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`, { mode: 0o600 });
    const { fetcher } = sender(() => reply("never"));
    globalThis.fetch = fetcher;
    const response = await send("computer_list", {});
    expect(response.result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks the arguments before any call goes out", async () => {
    trialFiles();
    const { fetcher } = sender(() => reply("never"));
    globalThis.fetch = fetcher;
    const cases: Array<[string, unknown, string]> = [
      ["computer_wake", {}, '"computer_id" is required.'],
      ["computer_create", { size: "huge" }, '"size" must be one of small, standard, large, xlarge.'],
      ["computer_action", { computer_id: ID, action: "wiggle" }, '"action" must be one of click, double_click, type, key, scroll, drag.'],
      ["decide", { state: {} }, '"questions" is required.'],
      ["computer_list", [], "The arguments must be a JSON object."],
    ];
    for (const [name, args, message] of cases) {
      const response = await send(name, args);
      expect(response.error, name).toMatchObject({ code: -32602, message: `Invalid params: ${message}` });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never reaches the local later.dog server for a computer tool", async () => {
    trialFiles();
    const local = vi.fn(async () => ({}));
    const { fetcher } = sender(() => reply("ok"));
    globalThis.fetch = fetcher;
    const result = await handleToolCall("computer_list", {}, local);
    expect(local).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: { content: [{ type: "text", text: "ok" }] } });
  });
});
