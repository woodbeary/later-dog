import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { engineScripts } from "./engine-computer.ts";
import { claudeProjectSlug, planClaudeRemote, REMOTE_ENGINE_BASE, REMOTE_ENGINES_FILE, spawnPlacedEngine, type ClaudeRemotePlan, type EngineOpener } from "./engine-placement.ts";
import type { EngineLink } from "./engine-remote.ts";
import { attachPool, openOnPool, poolChosen, poolEngineOpener, poolLink, poolSetting, relayFiles, savePoolSetting, type PoolService } from "./pool-opener.ts";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const BOOT = here("../../deploy/laterdog/computers/pool-agent/pool-relay");
const FAKE = here("../testing/fake-remote-engine.ts");
const SESSION = "0a1b2c3d-0000-4000-8000-00000000000a";
const scratch: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) try { stop(); } catch {}
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakePool(root: string) {
  const server = new WebSocketServer({ port: 0 });
  const engines = new Map<string, ChildProcess>();
  const closed: string[] = [];
  let slot = 2;
  let pending: { chat: string; slot: number } | null = null;
  server.on("connection", (socket, request) => {
    const chat = new URL(request.url!, "http://pool").searchParams.get("chat")!;
    const scratchDir = join(root, `slot-${pending!.slot}`, "tmp");
    mkdirSync(scratchDir, { recursive: true });
    const child = spawn(process.execPath, [BOOT], { cwd: scratchDir, env: { PATH: process.env.PATH, TMPDIR: scratchDir, LATERDOG_ENGINE_FILES: relayFiles() }, stdio: ["pipe", "pipe", "pipe"] });
    engines.set(chat, child);
    socket.send(JSON.stringify({ channel: "attached", chat, buffered: 0 }));
    child.stdout.on("data", (bytes: Buffer) => socket.send(Buffer.concat([Buffer.from([1]), bytes])));
    child.stderr.on("data", (bytes: Buffer) => socket.send(Buffer.concat([Buffer.from([2]), bytes])));
    child.on("close", (code) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ channel: "exit", code })); socket.close(); });
    child.stdin.on("error", () => {});
    socket.on("message", (data, binary) => { if (binary && child.stdin.writable) child.stdin.write(data as Buffer); });
  });
  stops.push(() => { for (const child of engines.values()) child.kill("SIGKILL"); server.close(); });
  const port = () => (server.address() as { port: number }).port;
  const service: PoolService = {
    async open(chat) {
      slot += 1;
      pending = { chat, slot };
      return { status: 201, slot, state: "cold" };
    },
    async close(chat) { closed.push(chat); engines.get(chat)?.kill("SIGKILL"); },
    stream(chat, signal) { return attachPool(new WebSocket(`ws://127.0.0.1:${port()}/stream?chat=${chat}`), signal); },
  };
  return { service, closed, slots: () => slot };
}

function world() {
  const base = realpathSync(mkdtempSync("/tmp/ldpool-"));
  scratch.push(base);
  const cwd = join(base, "home", "work");
  const configDir = join(base, "home", "config");
  const engineBase = join(base, "engine");
  const poolRoot = join(base, "pool");
  for (const dir of [cwd, configDir, poolRoot, join(base, "launch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, "input.txt"), "from home");
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-value", refreshToken: "refresh-value", expiresAt: Date.now() + 2 * 3600_000 } }));
  writeFileSync(join(configDir, ".claude.json"), "{}");
  const pkg = join(base, "pkg", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "9.9.9" }));
  writeFileSync(join(pkg, "bin", "claude"), "#!/bin/sh\n");
  const remoteBin = join(engineBase, "cli", "claude-code-9.9.9", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const mcpServer = join(base, "mcp-echo.mjs");
  writeFileSync(mcpServer, `process.stdin.once("data", () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { secret: process.env.PROBE_SECRET, ran: process.cwd() } }) + "\\n"));\n`);
  const mcpPath = join(base, "launch", "mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [mcpServer], env: { PROBE_SECRET: "home-only" } } } }));
  const settingsPath = join(base, "launch", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "exit 0", timeout: 5 }] }] } }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: configDir };
  const plan = (resume: boolean): ClaudeRemotePlan => {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", mcpPath, "--settings", settingsPath, resume ? "--resume" : "--session-id", SESSION];
    const planned = planClaudeRemote({ botId: "bot-1", threadId: "thread-1", sessionId: SESSION, cliCommand: join(pkg, "bin", "claude"), args, cwd, env,
      managed: false, required: true, dataDir: join(base, "data"), proxyPath: engineScripts().proxy, remoteBase: engineBase });
    if (!("plan" in planned)) throw new Error(planned.stay);
    return planned.plan;
  };
  return { base, cwd, configDir, engineBase, poolRoot, plan, sessionFile: join(configDir, "projects", claudeProjectSlug(cwd), `${SESSION}.jsonl`) };
}

const message = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
function turn(engine: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }, text: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: engine.stdout });
    const timer = setTimeout(() => reject(new Error("no result")), 30_000);
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.type !== "result") return;
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(frame.result));
    });
    engine.stdin.write(message(text));
  });
}

async function poolEngine(w: ReturnType<typeof world>, pool: ReturnType<typeof fakePool>, resume: boolean) {
  const plan = w.plan(resume);
  let slot = 0;
  const engine = spawnPlacedEngine(plan, async (value, signal) => {
    const opened = await openOnPool(pool.service, "bot-1", value, engineScripts().proxy, signal, { root: w.poolRoot, engineBase: w.engineBase });
    slot = opened.slot;
    value.launch.env.FAKE_ENGINE_SLUG = claudeProjectSlug(`${w.poolRoot}/slot-${slot}/tmp/m${w.cwd}`);
    return opened.link;
  }, undefined);
  stops.push(() => engine.kill());
  return { engine, slot: () => slot };
}

it("runs a chat on a pool slot with home-held tools and credentials, keeps the workspace off the home, and resumes on another slot", async () => {
  const w = world();
  const pool = fakePool(w.poolRoot);
  const first = await poolEngine(w, pool, false);
  const one = await turn(first.engine, "hello");
  const scratchDir = `${w.poolRoot}/slot-${first.slot()}/tmp`;
  expect(one.cwd).toBe(`${scratchDir}/m${w.cwd}`);
  expect(JSON.parse(one.mcp).result).toEqual({ secret: "home-only", ran: w.cwd });
  expect(one).toMatchObject({ credentialAccess: true, credentialRefresh: false, sessionLines: 1, input: null });
  const two = await turn(first.engine, "again");
  expect(two.sessionLines).toBe(2);
  expect(readFileSync(w.sessionFile, "utf8").trim().split("\n")).toHaveLength(2);
  expect(existsSync(join(w.cwd, "turn-1.txt"))).toBe(false);
  expect(existsSync(join(w.engineBase, "run"))).toBe(false);
  first.engine.stdin.end();
  await new Promise((resolve) => first.engine.once("close", resolve));

  const second = await poolEngine(w, pool, true);
  const three = await turn(second.engine, "after a host restart");
  expect(second.slot()).not.toBe(first.slot());
  expect(three.sessionLines).toBe(3);
  expect(readFileSync(w.sessionFile, "utf8").trim().split("\n")).toHaveLength(3);
  second.engine.stdin.end();
}, 60_000);

it("delivers lines that arrive before anyone listens, and stops the pool engine when the stream ends", async () => {
  const sent: Buffer[] = [];
  const socket = Object.assign(new (await import("node:events")).EventEmitter(), { send: (bytes: Buffer) => sent.push(bytes), close: () => {} }) as unknown as WebSocket;
  let stopped = 0;
  const link: EngineLink = poolLink(socket, () => { stopped += 1; });
  socket.emit("message", Buffer.concat([Buffer.from([1]), Buffer.from('{"type":"ready"}\n{"a"')]), true);
  socket.emit("message", Buffer.concat([Buffer.from([1]), Buffer.from(':1}\n')]), true);
  const lines: string[] = [];
  link.on("line", (line) => lines.push(line));
  await Promise.resolve();
  expect(lines).toEqual(['{"type":"ready"}', '{"a":1}']);
  link.send("x");
  expect(sent.map(String)).toEqual(["x\n"]);
  const why = new Promise((resolve) => link.once("close", resolve));
  socket.emit("message", Buffer.from(JSON.stringify({ channel: "closed", reason: "memory" })), false);
  expect(await why).toBe("pool closed the engine: memory");
  expect(stopped).toBe(1);
});

it("chooses the pool only for the dogs the setting names and falls back to the dog's computer when the pool fails", async () => {
  const w = world();
  const data = join(w.base, "data");
  mkdirSync(data, { recursive: true });
  expect(poolChosen(data, "bot-1")).toBe(false);
  writeFileSync(join(data, REMOTE_ENGINES_FILE), JSON.stringify({ placement: "computer", pool: { enabled: true, bots: ["bot-2"] } }));
  expect(poolChosen(data, "bot-1")).toBe(false);
  expect(poolChosen(data, "bot-2")).toBe(true);
  writeFileSync(join(data, REMOTE_ENGINES_FILE), JSON.stringify({ pool: { enabled: false } }));
  expect(poolChosen(data, "bot-1")).toBe(false);
  writeFileSync(join(data, REMOTE_ENGINES_FILE), JSON.stringify({ pool: { enabled: true } }));
  expect(poolChosen(data, "bot-1")).toBe(true);
  writeFileSync(join(data, REMOTE_ENGINES_FILE), JSON.stringify({ placement: "computer", bots: ["bot-9"] }));
  expect(savePoolSetting(data, { enabled: true, bots: ["bot-1", "bot-1"] })).toEqual({ enabled: true, bots: ["bot-1"] });
  expect(JSON.parse(readFileSync(join(data, REMOTE_ENGINES_FILE), "utf8"))).toEqual({ placement: "computer", bots: ["bot-9"], pool: { enabled: true, bots: ["bot-1"] } });
  expect(poolSetting(data)).toEqual({ enabled: true, bots: ["bot-1"] });

  const computerLinks: string[] = [];
  const computer: EngineOpener = { proxyPath: "/p", openBudgetMs: 1, async open(botId) { computerLinks.push(botId); return {} as EngineLink; } };
  const failing: PoolService = { open: async () => ({ status: 503, refusal: "host_full: full" }), close: async () => {}, stream: async () => { throw new Error("unused"); } };
  const plan = w.plan(false);
  plan.launch.cli = `${REMOTE_ENGINE_BASE}/cli/claude-code-9.9.9/node_modules/.bin/claude`;
  const before = JSON.stringify(plan.launch.roots);
  const opener = poolEngineOpener(computer, data, () => failing);
  await opener.open("bot-1", plan);
  expect(computerLinks).toEqual(["bot-1"]);
  expect(JSON.stringify(plan.launch.roots)).toBe(before);
  expect(readFileSync(join(data, "engine-placement.log"), "utf8")).toContain("falls back to the dog's computer");
});
