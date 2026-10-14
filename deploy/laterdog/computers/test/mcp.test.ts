import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { DAY } from "../src/trial";
import { MINUTE } from "../src/idle";
import { type McpBackend, type McpComputerOp, handleMcp } from "../src/mcp";
import { MCP_PROTOCOL_VERSIONS, TOOLS } from "../src/mcp-tools";
import { ROOM_ROUTING_INSTRUCTIONS } from "../src/decide";
import { ORIGIN, OWNER_KEY, type World, apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const mcp = (key: string, method: string, params?: unknown, id: number | string = 1) =>
  apiRequest("POST", "/mcp", key, { body: { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } });

async function call(w: World, key: string, name: string, args: Record<string, unknown> = {}) {
  const response = await w.fetch(mcp(key, "tools/call", { name, arguments: args }));
  expect(response.status).toBe(200);
  return (await body(response)).result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: any; isError?: boolean };
}

const say = (result: { content: Array<{ text?: string }> }) => result.content.map((item) => item.text ?? "").join("\n");

const clefAnswer = (screen = "ready", changed = 0.9) => ({
  model: "clef-flash",
  answers: { screen: { type: "choice", choice: screen, probabilities: { [screen]: 0.97 } }, changed: { type: "noul", noul: changed } },
});

async function givePlan(w: World, key: string, status: "active" | "canceled" = "active", periodEnd = Date.now() + 30 * DAY) {
  const keySha256 = await sha256Hex(key);
  const registry = w.trials.named("trials");
  registry.planPending({ keySha256, ref: "r".repeat(32), linkId: "link", orderId: "order" });
  await registry.applyPlan({ keySha256, customerId: "cust", subscriptionId: "sub", status, periodEnd, limitMs: 40 * 60 * MINUTE, graceMs: 3 * DAY });
}

async function withDecisions(answers: unknown[] = [clefAnswer()], plan = false) {
  let at = 0;
  const run = vi.fn(async () => answers[Math.min(at++, answers.length - 1)]);
  const w = await world({ AI: { run, gateway: vi.fn() } } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("k");
  expect((await startTrial(w, key)).status).toBe(200);
  if (plan) await givePlan(w, key);
  return { w, run, key };
}

async function makeRunning(w: World, key: string, args: Record<string, unknown> = {}) {
  const created = await call(w, key, "computer_create", args);
  const id = created.structuredContent.computer.id as string;
  await w.advance(MINUTE);
  w.containers.get(id)!.reply = (cmd) => (cmd.join(" ").includes("scrot") ? { stdout: JPEG } : undefined);
  return id;
}

describe("the MCP endpoint's door", () => {
  it("asks for a key, refuses a wrong one, and refuses browsers", async () => {
    const w = await world();
    const none = await w.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }));
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await w.fetch(mcp("ldc_wrong", "ping"))).status).toBe(401);
    expect((await w.fetch(mcp(trialKey("z"), "ping"))).status).toBe(401);
    expect(await body(await w.fetch(mcp("ldc_wrong", "ping")))).toEqual({ error: { code: "unauthorized", message: "The API key is not valid." } });
    const browser = await w.fetch(apiRequest("POST", "/mcp", OWNER_KEY, { body: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { origin: "https://evil.example" } }));
    expect(browser.status).toBe(403);
    const unset = await world({ COMPUTERS_KEY_SHA256: "" });
    expect((await unset.fetch(mcp(OWNER_KEY, "ping"))).status).toBe(503);
  });

  it("accepts only POST, saying so", async () => {
    const w = await world();
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await w.fetch(apiRequest(method, "/mcp", OWNER_KEY));
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("is not reachable through the service binding", async () => {
    const w = await world();
    const { ComputersApi } = await import("../src/index");
    const api = new ComputersApi({} as ExecutionContext, w.env as unknown as Env);
    const response = await api.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }));
    expect(response.status).toBe(404);
  });
});

describe("the MCP protocol", () => {
  it("negotiates a version and describes the server", async () => {
    const w = await world();
    const params = (protocolVersion: string) => ({ protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const old = (await body(await w.fetch(mcp(OWNER_KEY, "initialize", params("2025-06-18"))))).result;
    expect(old).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "laterdog-computers" } });
    const future = (await body(await w.fetch(mcp(OWNER_KEY, "initialize", params("2099-01-01"))))).result;
    expect(future.protocolVersion).toBe(MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]);
    const bad = await body(await w.fetch(mcp(OWNER_KEY, "initialize", { protocolVersion: "2025-06-18" })));
    expect(bad.error.code).toBe(-32602);
  });

  it("lists every tool with a plain description and a strict schema", async () => {
    const w = await world();
    const { tools } = (await body(await w.fetch(mcp(OWNER_KEY, "tools/list")))).result;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      "computer_list",
      "computer_create",
      "computer_wake",
      "computer_sleep",
      "computer_screenshot",
      "computer_action",
      "computer_exec",
      "computer_viewer_link",
      "decide",
    ]);
    expect(tools).toEqual(JSON.parse(JSON.stringify(TOOLS)));
    for (const tool of tools) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.annotations.title, tool.name).toBeTruthy();
      for (const required of tool.inputSchema.required ?? []) expect(Object.keys(tool.inputSchema.properties)).toContain(required);
    }
    const create = tools.find((tool: { name: string }) => tool.name === "computer_create");
    expect(create.description).toContain("open internet access and passwordless root");
    expect(create.description).toContain("standard-1");
    expect(JSON.stringify(tools)).not.toContain("undefined");
  });

  it("answers ping, refuses unknown methods and tools, and treats notifications quietly", async () => {
    const w = await world();
    expect((await body(await w.fetch(mcp(OWNER_KEY, "ping")))).result).toEqual({});
    expect((await body(await w.fetch(mcp(OWNER_KEY, "resources/list")))).error).toMatchObject({ code: -32601 });
    const unknown = await body(await w.fetch(mcp(OWNER_KEY, "tools/call", { name: "rm_rf", arguments: {} })));
    expect(unknown.error).toMatchObject({ code: -32602, message: "There is no tool named rm_rf. Use tools/list to see them." });
    const notification = await w.fetch(apiRequest("POST", "/mcp", OWNER_KEY, { body: { jsonrpc: "2.0", method: "notifications/initialized" } }));
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
  });

  it("refuses bodies that are not one JSON-RPC message", async () => {
    const w = await world();
    const send = (raw: string) => w.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: `Bearer ${OWNER_KEY}` }, body: raw }));
    expect((await send("{nope")).status).toBe(400);
    expect((await send("[]")).status).toBe(400);
    expect((await send(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).status).toBe(400);
    expect((await send(JSON.stringify({ id: 1, method: "ping" }))).status).toBe(400);
    expect((await send(JSON.stringify({ jsonrpc: "2.0", id: { a: 1 }, method: "ping" }))).status).toBe(400);
    expect((await send(JSON.stringify({ jsonrpc: "2.0", id: 1 }))).status).toBe(400);
    expect((await send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }))).status).toBe(202);
    const huge = await send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(1024 * 1024) } }));
    expect(huge.status).toBe(413);
  });

  it("says in plain words what is wrong with a tool's arguments", async () => {
    const w = await world();
    const say1 = async (name: string, args: Record<string, unknown>) => {
      const result = await call(w, OWNER_KEY, name, args);
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      return say(result);
    };
    expect(await say1("computer_wake", {})).toBe('"computer_id" is required.');
    expect(await say1("computer_wake", { computer_id: "nope" })).toBe('"computer_id" is not in the expected format.');
    expect(await say1("computer_create", { size: "huge" })).toBe('"size" must be one of small, standard, large, xlarge.');
    expect(await say1("computer_create", { colour: "red" })).toBe('"colour" is not an argument this tool takes.');
    expect(await say1("computer_exec", { computer_id: "cmp_abcdefghij23", command: "" })).toBe('"command" must not be empty.');
    expect(await say1("computer_exec", { computer_id: "cmp_abcdefghij23", command: "ls", timeout_ms: 5 })).toBe('"timeout_ms" must be at least 1000.');
    expect(await say1("computer_action", { computer_id: "cmp_abcdefghij23", action: "wiggle" })).toBe('"action" must be one of click, double_click, type, key, scroll, drag.');
    expect(await say1("computer_action", { computer_id: "cmp_abcdefghij23", action: "click", x: 1.5, y: 2 })).toBe('"x" must be a whole number.');
    expect(await say1("computer_action", { computer_id: "cmp_abcdefghij23", action: "click", x: 5 })).toBe("click needs x and y.");
    expect(await say1("computer_action", { computer_id: "cmp_abcdefghij23", action: "key", key: "ctrl+l; rm -rf /" })).toBe('"key" is not in the expected format.');
    expect(await say1("decide", { state: {}, questions: {} })).toBe('"questions" needs at least 1 entries.');
    expect(await say1("decide", { state: {} })).toBe('"questions" is required.');
    const arguments_ = await body(await w.fetch(mcp(OWNER_KEY, "tools/call", { name: "computer_list", arguments: [] })));
    expect(say(arguments_.result)).toBe("The arguments must be a JSON object.");
  });
});

describe("computers over MCP", () => {
  it("runs a computer's whole life with the owner's key", async () => {
    const w = await world();
    expect((await call(w, OWNER_KEY, "computer_list")).structuredContent).toEqual({ computers: [] });
    const created = await call(w, OWNER_KEY, "computer_create", { name: "Desk" });
    expect(created.isError).toBeUndefined();
    expect(say(created)).toContain("call computer_wake");
    const computer = created.structuredContent.computer;
    expect(computer).toMatchObject({ name: "Desk", size: "small", state: "starting" });
    expect((await call(w, OWNER_KEY, "computer_create", { size: "large" })).structuredContent.computer.size).toBe("large");
    await w.advance(MINUTE);

    const woke = await call(w, OWNER_KEY, "computer_wake", { computer_id: computer.id });
    expect(woke.structuredContent).toMatchObject({ ready: true, computer: { id: computer.id, state: "running" } });

    const ran = await call(w, OWNER_KEY, "computer_exec", { computer_id: computer.id, command: "echo hi", cwd: "/tmp" });
    expect(ran.structuredContent).toBeUndefined();
    expect(JSON.parse(say(ran))).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const exec = w.containers.get(computer.id)!.execs.find((entry) => entry.cmd.includes("echo hi"))!;
    expect(exec.cmd.slice(0, 2)).toEqual(["timeout", "--kill-after=5"]);
    expect(exec.cmd[2]).toBe("30.000s");
    expect(exec.options).toMatchObject({ cwd: "/tmp", user: "1000:1000" });

    w.containers.get(computer.id)!.reply = (cmd) => (cmd.join(" ").includes("scrot") ? { stdout: JPEG } : undefined);
    const shot = await call(w, OWNER_KEY, "computer_screenshot", { computer_id: computer.id });
    expect(shot.content[1]).toEqual({ type: "image", data: btoa(String.fromCharCode(...JPEG)), mimeType: "image/jpeg" });

    const link = await call(w, OWNER_KEY, "computer_viewer_link", { computer_id: computer.id });
    expect(link.structuredContent.url).toContain(`${ORIGIN}/desktop/${computer.id}/`);
    expect(say(link)).toContain("keep it private");

    const slept = await call(w, OWNER_KEY, "computer_sleep", { computer_id: computer.id });
    expect(slept.structuredContent.computer.state).toBe("sleeping");
    const asleep = await call(w, OWNER_KEY, "computer_screenshot", { computer_id: computer.id });
    expect(asleep).toMatchObject({ isError: true });
    expect(say(asleep)).toContain("wake it first");
    const listed = (await call(w, OWNER_KEY, "computer_list")).structuredContent.computers;
    expect(listed.map((entry: { id: string }) => entry.id)).toContain(computer.id);
  });

  it("reports a command that ran out of time", async () => {
    const w = await world();
    const id = await makeRunning(w, OWNER_KEY);
    w.containers.get(id)!.reply = () => ({ exitCode: 124 });
    const started = Date.now();
    let tick = 0;
    vi.spyOn(Date, "now").mockImplementation(() => started + (tick += 2000));
    const ran = await call(w, OWNER_KEY, "computer_exec", { computer_id: id, command: "sleep 99", timeout_ms: 1000 });
    expect(say(ran)).toContain("ran out of time");
    expect(say(ran)).toContain('"timedOut": true');
  });

  it("gives a free trial the standard size and says so when it asks for more", async () => {
    const { w, key } = await withDecisions();
    const created = await call(w, key, "computer_create", { name: "Trial desk" });
    expect(created.structuredContent.computer).toMatchObject({ name: "Trial desk", size: "standard" });
    const second = await call(w, key, "computer_create", {});
    expect(second.isError).toBe(true);
    expect(say(second)).toContain("The free trial includes one cloud computer");
    const big = await call(w, key, "computer_create", { size: "large" });
    expect(say(big)).toBe("A free trial computer is the standard size.");
  });

  it("keeps each key to its own computers", async () => {
    const w = await world();
    siteverify();
    const [a, b] = [trialKey("a"), trialKey("b")];
    await startTrial(w, a, "198.51.100.1");
    await startTrial(w, b, "198.51.100.2");
    const ofA = (await call(w, a, "computer_create", {})).structuredContent.computer.id as string;
    const ofB = (await call(w, b, "computer_create", {})).structuredContent.computer.id as string;
    const owned = (await call(w, OWNER_KEY, "computer_create", { name: "owner" })).structuredContent.computer.id as string;
    const listed = async (key: string) => (await call(w, key, "computer_list")).structuredContent.computers.map((entry: { id: string }) => entry.id);
    expect(await listed(a)).toEqual([ofA]);
    expect(await listed(b)).toEqual([ofB]);
    expect(await listed(OWNER_KEY)).toEqual([owned]);
    for (const target of [ofB, owned]) {
      const attempts: Array<[string, Record<string, unknown>]> = [
        ["computer_wake", {}],
        ["computer_sleep", {}],
        ["computer_screenshot", {}],
        ["computer_exec", { command: "id" }],
        ["computer_viewer_link", {}],
        ["computer_action", { action: "key", key: "Return" }],
        ["decide", { state: {}, questions: { q: { type: "noul", instructions: "Is it?" } } }],
      ];
      for (const [name, args] of attempts) {
        const result = await call(w, a, name, { computer_id: target, ...args });
        expect(result.isError, `${name} ${target}`).toBe(true);
        expect(say(result), `${name} ${target}`).toBe("No computer with that id.");
      }
    }
    expect(w.containers.get(ofB)!.execs.some((entry) => entry.cmd.includes("id"))).toBe(false);
  });

  it("refuses a computer's id that is not well formed before asking the service", async () => {
    const w = await world();
    const result = await call(w, OWNER_KEY, "computer_screenshot", { computer_id: "cmp_ABCDEFGHIJ23" });
    expect(say(result)).toBe('"computer_id" is not in the expected format.');
  });
});

describe("computer_action over MCP", () => {
  const xdotool = (w: World, id: string) => w.containers.get(id)!.execs.map((entry) => entry.cmd.at(-1)!).filter((command) => command.startsWith("xdotool") && !command.includes("getdisplaygeometry"));

  it("acts, then returns a fresh screenshot with a screen check", async () => {
    const { w, run, key } = await withDecisions([clefAnswer("ready", 0.95)]);
    const id = await makeRunning(w, key);
    const result = await call(w, key, "computer_action", { computer_id: id, action: "click", x: 640, y: 400, expect: "The menu is open." });
    expect(result.isError).toBeUndefined();
    expect(xdotool(w, id)).toEqual(["xdotool mousemove --sync 640 400 click 1"]);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(result.structuredContent).toEqual({
      computer_id: id,
      did: "click at (640, 400)",
      screen_check: { screen: "ready", confidence: 0.97, changed: 0.95, looks: 1 },
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input, options] = run.mock.calls[0] as unknown as [string, any, any];
    expect(model).toBe("@cf/cloudflare/clef-flash");
    expect(input.images).toHaveLength(2);
    expect(input.state).toMatchObject({ action: "click at (640, 400)", expected: "The menu is open." });
    expect(Object.keys(input.questions)).toEqual(["screen", "changed", "matches_expectation"]);
    expect(options).toEqual({ gateway: { id: "default", collectLog: false } });
  });

  it("builds each kind of action as an xdotool command and never sends typed text to the model", async () => {
    const { w, run, key } = await withDecisions();
    const id = await makeRunning(w, key);
    const secret = "it's a p@ss; $(reboot)";
    const steps: Array<[Record<string, unknown>, string]> = [
      [{ action: "click", x: 1, y: 2, button: "right" }, "xdotool mousemove --sync 1 2 click 3"],
      [{ action: "double_click", x: 3, y: 4 }, "xdotool mousemove --sync 3 4 click --repeat 2 --delay 80 1"],
      [{ action: "type", text: secret }, "xdotool type --delay 12 -- 'it'\\''s a p@ss; $(reboot)'"],
      [{ action: "key", key: "ctrl+shift+t Return" }, "xdotool key -- 'ctrl+shift+t' 'Return'"],
      [{ action: "scroll" }, "xdotool click --repeat 5 --delay 40 5"],
      [{ action: "scroll", x: 10, y: 20, direction: "up", amount: 3 }, "xdotool mousemove --sync 10 20 click --repeat 3 --delay 40 4"],
      [{ action: "drag", x: 5, y: 6, to_x: 50, to_y: 60 }, "xdotool mousemove --sync 5 6 mousedown 1 sleep 0.1 mousemove --sync 50 60 sleep 0.1 mouseup 1"],
    ];
    for (const [args, command] of steps) {
      const result = await call(w, key, "computer_action", { computer_id: id, ...args });
      expect(result.isError, JSON.stringify(args)).toBeUndefined();
      expect(xdotool(w, id).at(-1)).toBe(command);
    }
    expect(JSON.stringify(run.mock.calls)).not.toContain("reboot");
    expect(JSON.stringify(run.mock.calls)).toContain("typed 22 characters");
  }, 30_000);

  it("still returns the screenshot when decisions are not available to the key", async () => {
    const run = vi.fn();
    const w = await world({ AI: { run, gateway: vi.fn() } } as unknown as Record<string, string>);
    const id = await makeRunning(w, OWNER_KEY);
    const result = await call(w, OWNER_KEY, "computer_action", { computer_id: id, action: "key", key: "Return" });
    expect(result.isError).toBeUndefined();
    expect(result.content[1]).toMatchObject({ type: "image" });
    expect(result.structuredContent.screen_check).toEqual({ unavailable: "Screen checks come with a free trial or later.dog Cloud key. This key gets the screenshot only." });
    expect(w.containers.get(id)!.execs.filter((entry) => entry.cmd.join(" ").includes("scrot --overwrite --pointer"))).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("gives screen checks their own budget, apart from room routing and free-form decisions", async () => {
    const { w, run, key } = await withDecisions();
    const id = await makeRunning(w, key);
    const keySha256 = await sha256Hex(key);
    const registry = w.trials.named("trials");
    expect(await registry.allowUsage({ keySha256, kind: "screen_checks", amount: 1000, perKey: 1000, total: 100_000 })).toEqual({ ok: true });
    const spent = await call(w, key, "computer_action", { computer_id: id, action: "key", key: "Return" });
    expect(spent.isError).toBeUndefined();
    expect(spent.content[1]).toMatchObject({ type: "image" });
    expect(spent.structuredContent.screen_check).toEqual({ unavailable: "Today's screen checks are used up, so there is no screen check. The screenshot is still returned." });
    expect(run).not.toHaveBeenCalled();
    const routing = { state: { room: {}, humans_in_room: [], bots_in_room: [], new_message: {} }, questions: { answer: { type: "choice", instructions: ROOM_ROUTING_INSTRUCTIONS, criteria: { a: "A", b: "B" } } } };
    expect((await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: routing }))).status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("counts every loading re-shoot toward the screen check budget", async () => {
    const { w, run, key } = await withDecisions([clefAnswer("loading"), clefAnswer("loading"), clefAnswer("ready")]);
    const id = await makeRunning(w, key);
    const registry = w.trials.named("trials");
    const keySha256 = await sha256Hex(key);
    await registry.allowUsage({ keySha256, kind: "screen_checks", amount: 998, perKey: 1000, total: 100_000 });
    const result = await call(w, key, "computer_action", { computer_id: id, action: "key", key: "F5" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.structuredContent.screen_check).toMatchObject({ unavailable: expect.stringContaining("screen checks are used up") });
  }, 20_000);

  it("scales the typing timeout to the text and refuses long or NUL text", async () => {
    const { w, key } = await withDecisions();
    const id = await makeRunning(w, key);
    const typed = await call(w, key, "computer_action", { computer_id: id, action: "type", text: "x".repeat(1000) });
    expect(typed.isError).toBeUndefined();
    const exec = w.containers.get(id)!.execs.find((entry) => entry.cmd.at(-1)!.startsWith("xdotool type"))!;
    expect(exec.cmd[2]).toBe("17.000s");
    const keyed = await call(w, key, "computer_action", { computer_id: id, action: "key", key: "Return" });
    expect(keyed.isError).toBeUndefined();
    expect(w.containers.get(id)!.execs.find((entry) => entry.cmd.at(-1)!.startsWith("xdotool key"))!.cmd[2]).toBe("20.000s");
    expect(say(await call(w, key, "computer_action", { computer_id: id, action: "type", text: "x".repeat(1001) }))).toBe('"text" must be at most 1000 characters.');
    expect(say(await call(w, key, "computer_action", { computer_id: id, action: "type", text: "a\u0000b" }))).toBe("type text cannot contain a NUL character.");
  }, 20_000);

  it("reports a failed action plainly and takes no screenshot after it", async () => {
    const w = await world();
    const id = await makeRunning(w, OWNER_KEY);
    w.containers.get(id)!.reply = (cmd) => {
      const joined = cmd.join(" ");
      if (joined.includes("scrot")) return { stdout: JPEG };
      if (joined.includes("xdotool")) return { exitCode: 1, stderr: "Can't open display :0\n" };
      return undefined;
    };
    const result = await call(w, OWNER_KEY, "computer_action", { computer_id: id, action: "key", key: "Return" });
    expect(result.isError).toBe(true);
    expect(say(result)).toBe("The action did not work: Can't open display :0");
    expect(w.containers.get(id)!.execs.filter((entry) => entry.cmd.join(" ").includes("scrot --overwrite --pointer"))).toHaveLength(0);
  });
});

describe("decide over MCP", () => {
  const question = { type: "choice", instructions: "Which fits?", criteria: { a: "Option A", b: "Option B" } };

  it("passes Jev-format questions, images and the chosen model to Clef", async () => {
    const { w, run, key } = await withDecisions([{ model: "clef", answers: { fit: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 } } } }], true);
    const png = `data:image/png;base64,${btoa("\x89PNG\r\n\x1a\npixels")}`;
    const result = await call(w, key, "decide", { state: { topic: "x" }, questions: { fit: question, bad: { type: "score", instructions: "How bad?", criteria: ["low", "high"] }, ok: { type: "noul", instructions: "Fine?", criteria: { true: "yes", false: "no" } } }, images: [png], model: "clef-flash" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.answers.fit.choice).toBe("a");
    expect(run).toHaveBeenCalledWith(
      "@cf/cloudflare/clef-flash",
      {
        model: "clef-flash",
        state: { topic: "x" },
        questions: { fit: question, bad: { type: "score", instructions: "How bad?", criteria: ["low", "high"] }, ok: { type: "noul", instructions: "Fine?", criteria: { true: "yes", false: "no" } } },
        images: [png],
      },
      { gateway: { id: "default", collectLog: false } },
    );
  });

  it("adds a fresh screenshot of a computer as the last image", async () => {
    const { w, run, key } = await withDecisions(undefined, true);
    const id = await makeRunning(w, key);
    await call(w, key, "decide", { state: "x", questions: { q: question }, computer_id: id });
    const input = (run.mock.calls[0] as unknown as [string, { images: string[] }])[1];
    expect(input.images).toEqual([`data:image/jpeg;base64,${btoa(String.fromCharCode(...JPEG))}`]);
    const png = `data:image/png;base64,${btoa("\x89PNG\r\n\x1a\npixels")}`;
    const full = await call(w, key, "decide", { state: "x", questions: { q: question }, computer_id: id, images: [png, png, png, png] });
    expect(full.isError).toBe(true);
    expect(say(full)).toBe("Send at most four images, counting the computer's screenshot.");
    const three = await call(w, key, "decide", { state: "x", questions: { q: question }, computer_id: id, images: [png, png, png] });
    expect(three.isError).toBeUndefined();
    expect((run.mock.calls[1] as unknown as [string, { images: string[] }])[1].images).toHaveLength(4);
  });

  it("is for keys with a later.dog Cloud plan, and says so to every other key", async () => {
    const { w, run, key } = await withDecisions();
    const refusal = "Free-form decisions come with the later.dog Cloud plan.";
    for (const bare of [key, OWNER_KEY]) {
      const result = await call(w, bare, "decide", { state: {}, questions: { q: question } });
      expect(result.isError).toBe(true);
      expect(say(result)).toBe(refusal);
    }
    await givePlan(w, key, "active", Date.now() - 4 * DAY);
    expect(say(await call(w, key, "decide", { state: {}, questions: { q: question } }))).toBe(refusal);
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts an active plan, a cancelled one still paid for, and one inside its grace days", async () => {
    for (const [status, end] of [["active", Date.now() + 30 * DAY], ["canceled", Date.now() + 5 * DAY], ["active", Date.now() - 2 * DAY]] as const) {
      const { w, run, key } = await withDecisions();
      await givePlan(w, key, status, end);
      expect((await call(w, key, "decide", { state: {}, questions: { q: question } })).isError, `${status} ${end}`).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("has its own 200 a day, apart from screen checks and room routing", async () => {
    const { w, run, key } = await withDecisions(undefined, true);
    const registry = w.trials.named("trials");
    const keySha256 = await sha256Hex(key);
    expect(await registry.allowUsage({ keySha256, kind: "tool_decisions", amount: 200, perKey: 200, total: 20_000 })).toEqual({ ok: true });
    const used = await call(w, key, "decide", { state: {}, questions: { q: question } });
    expect(used.isError).toBe(true);
    expect(say(used)).toBe("This installation has used today's allowance. It resets at midnight UTC.");
    expect(run).not.toHaveBeenCalled();
    const id = await makeRunning(w, key);
    const action = await call(w, key, "computer_action", { computer_id: id, action: "key", key: "Return" });
    expect(action.structuredContent.screen_check).toMatchObject({ screen: "ready" });
  });

  it("refuses what the model should not be asked, before calling it", async () => {
    const { w, run, key } = await withDecisions(undefined, true);
    const refused = async (args: Record<string, unknown>) => {
      const result = await call(w, key, "decide", args);
      expect(result.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
      return say(result);
    };
    expect(await refused({ state: {}, questions: { Bad_Id: question } })).toBe('"questions.Bad_Id" is not an allowed name.');
    expect(await refused({ state: {}, questions: { q: { type: "choice", instructions: "x", criteria: { only: "one" } } } })).toBe('"questions.q.criteria" needs at least 2 entries.');
    expect(await refused({ state: {}, questions: { q: { type: "essay", instructions: "x" } } })).toBe('"questions.q.type" must be one of choice, score, noul.');
    expect(await refused({ state: {}, questions: { q: question }, model: "clef-omni" })).toBe('"model" must be one of clef, clef-flash.');
    expect(await refused({ state: {}, questions: { q: question }, images: ["https://example.com/a.png"] })).toBe('"images[0]" is not in the expected format.');
    expect(await refused({ state: {}, questions: { q: question }, images: [`data:image/png;base64,${btoa("GIF89a-not-a-png")}`] })).toBe("An image does not match its type.");
    expect(await refused({ state: "x".repeat(30_000), questions: { q: question } })).toBe("The state is too large.");
    expect(await refused({ state: {}, questions: { a: question, b: question, c: question, d: question, e: question } })).toBe('"questions" may have at most 4 entries.');
    expect(run).not.toHaveBeenCalled();
  });

  it("counts against the key's decisions and the network limits", async () => {
    const { w, run, key } = await withDecisions(undefined, true);
    let allowed = true;
    (w.env as Record<string, unknown>).INCLUDED_LIMIT = { limit: async () => ({ success: allowed }) };
    expect((await call(w, key, "decide", { state: {}, questions: { q: question } })).isError).toBeUndefined();
    allowed = false;
    const limited = await call(w, key, "decide", { state: {}, questions: { q: question } });
    expect(limited.isError).toBe(true);
    expect(say(limited)).toBe("Too many requests from this network. Wait a minute, then try again.");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("says so when the model fails", async () => {
    const { w, run, key } = await withDecisions(undefined, true);
    run.mockRejectedValueOnce(new Error("boom"));
    const result = await call(w, key, "decide", { state: {}, questions: { q: question } });
    expect(say(result)).toBe("The service did not answer. Try again.");
  });

  it("leaves /v1/systemone answering only later.dog's own questions", async () => {
    const { w, run, key } = await withDecisions(undefined, true);
    const response = await w.fetch(apiRequest("POST", "/v1/systemone", key, { body: { state: {}, questions: { answer: question } } }));
    expect(response.status).toBe(422);
    expect(run).not.toHaveBeenCalled();
  });
});

type Seen = { op: McpComputerOp | "list" | "create" | "screenCheck" | "decide"; id?: string; input?: unknown };

function fakeBackend(handlers: Partial<Record<Seen["op"], (seen: Seen) => Response | Promise<Response>>>, screenChecks = true) {
  const seen: Seen[] = [];
  const answer = (op: Seen["op"], id?: string, input?: unknown) => {
    const entry: Seen = { op, ...(id === undefined ? {} : { id }), ...(input === undefined ? {} : { input }) };
    seen.push(entry);
    const handler = handlers[op];
    return handler ? handler(entry) : Response.json({}, { status: 500 });
  };
  const backend: McpBackend = {
    screenChecks,
    list: async () => answer("list"),
    create: async (input) => answer("create", undefined, input),
    computer: async (op, id, input) => answer(op, id, input),
    screenCheck: async (input) => answer("screenCheck", undefined, input),
    decide: async (input) => answer("decide", undefined, input),
  };
  return { backend, seen };
}

const ID = "cmp_abcdefghij23";
const frame = () => new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
const ran = (exitCode = 0, stderr = "") => Response.json({ exitCode, stdout: "", stderr, timedOut: false });
const reading = (screen: string) => Response.json(clefAnswer(screen));

async function unit(deps: { backend: McpBackend; wait?: (ms: number) => Promise<void> }, name: string, args: Record<string, unknown>) {
  const response = await handleMcp(
    new Request(`${ORIGIN}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    deps,
  );
  return ((await response.json()) as { result: unknown }).result as { content: Array<{ type: string; text?: string }>; structuredContent?: any; isError?: boolean };
}

describe("the action loop", () => {
  it("looks again while the screen is loading, about a second apart, then stops", async () => {
    const waits: number[] = [];
    const readings = ["loading", "loading", "ready"];
    const { backend, seen } = fakeBackend({ screenshot: frame, exec: () => ran(), screenCheck: () => reading(readings.shift()!) });
    const result = await unit({ backend, wait: async (ms) => void waits.push(ms) }, "computer_action", { computer_id: ID, action: "click", x: 1, y: 2 });
    expect(result.structuredContent.screen_check).toMatchObject({ screen: "ready", looks: 3 });
    expect(waits).toEqual([500, 1000, 1000]);
    expect(seen.filter((entry) => entry.op === "screenshot")).toHaveLength(4);
    expect(seen.filter((entry) => entry.op === "screenCheck")).toHaveLength(3);
  });

  it("gives up after three more looks at a screen that never finishes loading", async () => {
    const { backend, seen } = fakeBackend({ screenshot: frame, exec: () => ran(), screenCheck: () => reading("loading") });
    const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "F5" });
    expect(result.structuredContent.screen_check).toMatchObject({ screen: "loading", looks: 4 });
    expect(seen.filter((entry) => entry.op === "screenCheck")).toHaveLength(4);
  });

  it("asks for a person on a sign-in, a code or a captcha", async () => {
    for (const screen of ["login", "two_factor", "captcha"]) {
      const { backend } = fakeBackend({ screenshot: frame, exec: () => ran(), screenCheck: () => reading(screen) });
      const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
      expect(result.structuredContent.screen_check.screen).toBe(screen);
      expect(result.structuredContent.needs_a_person).toContain("computer_viewer_link");
    }
    const { backend } = fakeBackend({ screenshot: frame, exec: () => ran(), screenCheck: () => reading("error") });
    const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
    expect(result.structuredContent.needs_a_person).toBeUndefined();
  });

  it("stops checking once decisions fail, and says why", async () => {
    const { backend, seen } = fakeBackend({
      screenshot: frame,
      exec: () => ran(),
      screenCheck: () => Response.json({ error: { code: "rate_limited", message: "You have used today's decisions." } }, { status: 429 }),
    });
    const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.screen_check).toEqual({ unavailable: "You have used today's decisions." });
    expect(seen.filter((entry) => entry.op === "screenCheck")).toHaveLength(1);
  });

  it("does not trust an answer it cannot read", async () => {
    for (const odd of [{}, { answers: { screen: { choice: "sparkly" } } }, { answers: [] }]) {
      const { backend } = fakeBackend({ screenshot: frame, exec: () => ran(), screenCheck: () => Response.json(odd) });
      const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
      expect(result.structuredContent.screen_check).toEqual({ unavailable: "The decision model gave an answer that could not be read." });
    }
  });

  it("skips the check, not the screenshot, when a frame is too big to send", async () => {
    const big = () => new Response(new Uint8Array(150_000).fill(7), { headers: { "content-type": "image/jpeg" } });
    const { backend, seen } = fakeBackend({ screenshot: big, exec: () => ran(), screenCheck: () => reading("ready") });
    const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
    expect(result.structuredContent.screen_check.unavailable).toContain("too large for a screen check");
    expect(result.content[1]).toMatchObject({ type: "image" });
    expect(seen.some((entry) => entry.op === "screenCheck")).toBe(false);
  });

  it("passes the service's own words through when the computer is not there", async () => {
    const { backend } = fakeBackend({ screenshot: () => Response.json({ error: { code: "asleep", message: "The computer is not running (it is sleeping; wake it first)." } }, { status: 409 }) });
    const result = await unit({ backend }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
    expect(result).toMatchObject({ isError: true, content: [{ text: "The computer is not running (it is sleeping; wake it first)." }] });
    const odd = fakeBackend({ screenshot: () => new Response("<html>", { status: 400 }) });
    expect(say(await unit(odd, "computer_screenshot", { computer_id: ID }))).toBe("The computers service answered 400.");
  });

  it("turns an unexpected failure into a short plain message and logs it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { backend } = fakeBackend({ list: () => Promise.reject(new Error("db exploded")) });
    const result = await unit({ backend }, "computer_list", {});
    expect(result).toMatchObject({ isError: true });
    expect(say(result)).toBe("Something went wrong on the computers service. The error was logged; try again.");
    expect(errors).toHaveBeenCalled();
    expect(say(result)).not.toContain("exploded");
  });
});

describe("waking a computer", () => {
  const states = (...list: string[]) => {
    const rest = [...list];
    return () => Response.json({ computer: { id: ID, name: ID, size: "small", state: rest.length > 1 ? rest.shift() : rest[0] } });
  };

  const drawing = (...list: Array<[string, boolean]>) => {
    const rest = [...list];
    return () => {
      const [state, desktopAvailable] = rest.length > 1 ? rest.shift()! : rest[0]!;
      return Response.json({ computer: { id: ID, name: ID, size: "small", state, desktopAvailable } });
    };
  };

  it("waits for the desktop to be drawn, not only for the computer to run", async () => {
    const waits: number[] = [];
    const { backend, seen } = fakeBackend({ wake: drawing(["starting", false]), get: drawing(["running", false], ["running", false], ["running", true]) });
    const result = await unit({ backend, wait: async (ms) => void waits.push(ms) }, "computer_wake", { computer_id: ID });
    expect(result.structuredContent).toMatchObject({ ready: true, computer: { state: "running", desktopAvailable: true } });
    expect(waits).toEqual([500, 500, 500]);
    expect(seen.map((entry) => entry.op)).toEqual(["wake", "get", "get", "get"]);
  });

  it("says it is not ready while a running computer's desktop is still being drawn", async () => {
    const waits: number[] = [];
    const { backend } = fakeBackend({ wake: drawing(["running", false]), get: drawing(["running", false]) });
    const result = await unit({ backend, wait: async (ms) => void waits.push(ms) }, "computer_wake", { computer_id: ID });
    expect(result.structuredContent.ready).toBe(false);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
  });

  it("waits for a starting computer to run", async () => {
    const waits: number[] = [];
    const { backend, seen } = fakeBackend({ wake: states("starting"), get: states("starting", "running") });
    const result = await unit({ backend, wait: async (ms) => void waits.push(ms) }, "computer_wake", { computer_id: ID });
    expect(result.structuredContent).toMatchObject({ ready: true, computer: { state: "running" } });
    expect(waits).toEqual([500, 500]);
    expect(seen.map((entry) => entry.op)).toEqual(["wake", "get", "get"]);
  });

  it("stops waiting after about 30 seconds and says to call again", async () => {
    const waits: number[] = [];
    const { backend } = fakeBackend({ wake: states("starting"), get: states("starting") });
    const result = await unit({ backend, wait: async (ms) => void waits.push(ms) }, "computer_wake", { computer_id: ID });
    expect(result.structuredContent.ready).toBe(false);
    expect(say(result)).toContain("Call computer_wake again");
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(30_000);
  });

  it("reports a computer that failed to start", async () => {
    const { backend } = fakeBackend({ wake: () => Response.json({ computer: { id: ID, state: "error", error: "no capacity" } }) });
    const result = await unit({ backend }, "computer_wake", { computer_id: ID });
    expect(result).toMatchObject({ isError: true });
    expect(say(result)).toBe("The computer could not start: no capacity");
  });
});

describe("what a tool says when the service has a problem", () => {
  const problem = "The computer had a problem. Try again in a minute.";

  it("hides server errors behind one sentence and logs the original", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [status, code] of [[502, "container_error"], [502, "start_failed"], [500, "internal"], [503, "weird"], [504, ""]] as const) {
      const { backend } = fakeBackend({ screenshot: () => Response.json({ error: { code, message: "docker exploded at /var/lib/secret" } }, { status }) });
      const result = await unit({ backend }, "computer_screenshot", { computer_id: ID });
      expect(result, `${status} ${code}`).toMatchObject({ isError: true, content: [{ text: problem }] });
    }
    expect(errors).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(errors.mock.calls)).toContain("docker exploded");
  });

  it("keeps the plain sentences the service means for people, even on a 503", async () => {
    for (const code of ["busy_today", "not_included", "trials_off"]) {
      const { backend } = fakeBackend({ screenshot: () => Response.json({ error: { code, message: `Plain words for ${code}.` } }, { status: 503 }) });
      expect(say(await unit({ backend }, "computer_screenshot", { computer_id: ID }))).toBe(`Plain words for ${code}.`);
    }
  });

  it("cuts a long message to 300 characters", async () => {
    const { backend } = fakeBackend({ screenshot: () => Response.json({ error: { code: "invalid_path", message: "x".repeat(900) } }, { status: 400 }) });
    expect(say(await unit({ backend }, "computer_screenshot", { computer_id: ID }))).toBe(`${"x".repeat(300)}...`);
  });
});

describe("computer_exec output", () => {
  it("cuts each stream at 100,000 characters, says so, and does not repeat the result", async () => {
    const { backend } = fakeBackend({ exec: () => Response.json({ exitCode: 1, stdout: "o".repeat(250_000), stderr: "short", timedOut: false }) });
    const result = await unit({ backend }, "computer_exec", { computer_id: ID, command: "yes" });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const shown = JSON.parse(say(result));
    expect(shown.stderr).toBe("short");
    expect(shown.stdout.startsWith("o".repeat(100_000))).toBe(true);
    expect(shown.stdout).toContain("[later.dog: output cut; showing the first 100000 of 250000 characters]");
    expect(shown.stdout.length).toBeLessThan(100_200);
    expect(shown.exitCode).toBe(1);
  });
});

describe("a caller that cannot have screen checks", () => {
  it("gets the screenshot after the action, with no before shot and no check", async () => {
    const { backend, seen } = fakeBackend({ screenshot: frame, exec: () => ran() }, false);
    const result = await unit({ backend, wait: async () => undefined }, "computer_action", { computer_id: ID, action: "key", key: "Return" });
    expect(seen.map((entry) => entry.op)).toEqual(["exec", "screenshot"]);
    expect(result.structuredContent.screen_check).toEqual({ unavailable: "Screen checks come with a free trial or later.dog Cloud key. This key gets the screenshot only." });
    expect(result.content[1]).toMatchObject({ type: "image" });
  });
});

describe("the MCP path", () => {
  it("answers with or without a trailing slash", async () => {
    const w = await world();
    for (const path of ["/mcp", "/mcp/"]) {
      const response = await w.fetch(apiRequest("POST", path, OWNER_KEY, { body: { jsonrpc: "2.0", id: 1, method: "ping" } }));
      expect(response.status, path).toBe(200);
    }
  });
});
