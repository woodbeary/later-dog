import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { killCliTree } from "../procs.ts";
import { alwaysAskHook } from "./always-asks.ts";
import { diskFloorDecision } from "./disk-floor.ts";
import { diskRung } from "./disk-ladder.ts";
import { claudeProjectSlug, planClaudeRemote, spawnPlacedEngine, type ClaudeRemotePlan, type PlacedEngineOptions } from "./engine-placement.ts";
import type { EngineWait } from "./engine-waiting.ts";
import { placedThreads, preToolGuardDecision } from "./placed-threads.ts";
import { createClaudeRefreshGate } from "./claude-refresh-lock.ts";
import { commandLink, EngineProcess, RemoteSession, type EngineLink } from "./engine-remote.ts";
import { createClaudeRenewer, type ClaudeRenewer } from "./engine-renewal.ts";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const RELAY = here("./engine-relay.ts");
const PROXY = here("./engine-proxy.ts");
const FAKE = here("../testing/fake-remote-engine.ts");
const scratch: string[] = [];
const running: Array<{ kill(): unknown }> = [];
const servers: Server[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
  for (const child of running.splice(0)) try { child.kill(); } catch {}
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function world(sessionId = "s-1", options: { preToolUse?: string; env?: Record<string, string> } = {}) {
  const base = realpathSync(mkdtempSync("/tmp/ldeng-"));
  scratch.push(base);
  const cwd = join(base, "home", "work");
  const configDir = join(base, "home", "config");
  const remoteRoot = join(base, "remote");
  const remoteBase = join(base, "rb");
  for (const dir of [cwd, configDir, remoteRoot, join(base, "launch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, "input.txt"), "from home");
  writeFileSync(join(cwd, "remove-me.txt"), "old");
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-value", refreshToken: "refresh-value", expiresAt: Date.now() + 2 * 3600_000 } }));
  writeFileSync(join(configDir, ".claude.json"), "{}");
  const pkg = join(base, "pkg", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "9.9.9" }));
  writeFileSync(join(pkg, "bin", "claude"), "#!/bin/sh\n");
  const remoteBin = join(remoteBase, "cli", "claude-code-9.9.9", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const mcpServer = join(base, "mcp-echo.mjs");
  writeFileSync(mcpServer, `process.stdin.once("data", () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { secret: process.env.PROBE_SECRET, ran: process.cwd() } }) + "\\n"));\n`);
  const hookScript = join(base, "hook.mjs");
  writeFileSync(hookScript, `import { appendFileSync } from "node:fs"; let text = ""; process.stdin.on("data", (b) => text += b); process.stdin.on("end", () => { appendFileSync(${JSON.stringify(join(base, "hooks.jsonl"))}, text + "\\n"); process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", token: Boolean(process.env.LATERDOG_HOOK_TOKEN_FILE) } })); });\n`);
  const mcpPath = join(base, "launch", "mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [mcpServer], env: { PROBE_SECRET: "home-only" }, alwaysLoad: true } } }));
  const settingsPath = join(base, "launch", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: options.preToolUse ?? "exit 2", timeout: 5 }] }], PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: `"${process.execPath}" "${hookScript}"`, timeout: 5 }] }] } }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: configDir, FAKE_ENGINE_SLUG: claudeProjectSlug(cwd),
    FAKE_ENGINE_LAUNCHES: join(base, "launches.txt"), LATERDOG_HOOK_TOKEN_FILE: join(base, "token"), ...options.env,
  };
  const args = (resume: boolean) => ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", mcpPath, "--settings", settingsPath, resume ? "--resume" : "--session-id", sessionId];
  const plan = (resume = false) => {
    const planned = planClaudeRemote({ botId: "bot-1", threadId: "thread-1", sessionId, cliCommand: join(pkg, "bin", "claude"), args: args(resume), cwd, env,
      managed: false, dataDir: join(base, "data"), proxyPath: PROXY, remoteBase });
    if (!("plan" in planned)) throw new Error(planned.stay);
    Object.assign(planned.plan.launch.env, { FAKE_ENGINE_SLUG: env.FAKE_ENGINE_SLUG, FAKE_ENGINE_LAUNCHES: env.FAKE_ENGINE_LAUNCHES });
    return planned.plan;
  };
  const relays: ChildProcess[] = [];
  const relay = (): EngineLink => {
    const link = commandLink(process.execPath, [RELAY], { ...process.env, LATERDOG_ENGINE_TEST_ROOT: remoteRoot });
    return link;
  };
  let localLaunches = 0;
  const local = (resume = false) => () => {
    localLaunches += 1;
    const child = spawn(process.execPath, [FAKE, ...args(resume)], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    running.push(child);
    return child;
  };
  const start = (planned: ClaudeRemotePlan, link: () => Promise<EngineLink> = async () => relay(), resume = false, renewer?: ClaudeRenewer, options?: PlacedEngineOptions) => {
    const placed: string[] = [];
    const reasons: Array<string | undefined> = [];
    const engine = spawnPlacedEngine(planned, link, local(resume), (where, why) => { placed.push(where); reasons.push(why); }, renewer, options);
    running.push(engine);
    return { engine, placed, reasons };
  };
  const mirror = (path: string) => join(remoteRoot, path);
  return { base, cwd, configDir, remoteRoot, remoteBase, plan, start, relay, mirror, relays, localLaunches: () => localLaunches,
    launches: () => existsSync(join(base, "launches.txt")) ? readFileSync(join(base, "launches.txt"), "utf8").trim().split("\n") : [],
    sessionFile: join(configDir, "projects", claudeProjectSlug(cwd), `${sessionId}.jsonl`) };
}

const message = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
function turn(engine: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }, text: string, onResult?: () => void): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: engine.stdout });
    let stderr = "";
    (engine as unknown as { stderr: NodeJS.ReadableStream }).stderr.on("data", (bytes) => { stderr += bytes; });
    const timer = setTimeout(() => reject(new Error(`no result; stderr: ${stderr}`)), 30_000);
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.type !== "result") return;
      onResult?.();
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(frame.result));
    });
    engine.stdin.write(message(text));
  });
}
const closed = (engine: { once(event: "close", listener: (code: number | null) => void): unknown }) => new Promise<number | null>((resolve) => engine.once("close", resolve));

it("runs a turn on the computer with home-held tools, hooks and authority, and returns files before the result", async () => {
  const w = world();
  const { engine, placed } = w.start(w.plan());
  let atResult: Record<string, boolean> = {};
  const result = await turn(engine, "hello", () => {
    atResult = { turnFile: existsSync(join(w.cwd, "turn-1.txt")), session: existsSync(w.sessionFile), removed: !existsSync(join(w.cwd, "remove-me.txt")) };
  });
  expect(placed).toEqual(["computer"]);
  expect(result.cwd).toBe(w.mirror(w.cwd));
  expect(result.input).toBe("from home");
  expect(JSON.parse(result.mcp).result).toEqual({ secret: "home-only", ran: w.cwd });
  expect(JSON.parse(result.hook).hookSpecificOutput).toEqual({ permissionDecision: "deny", token: true });
  expect(result.hookAuthorityVisible).toBe(false);
  expect(result.shellGuard).toBe(true);
  expect(result).toMatchObject({ credentialAccess: true, credentialRefresh: false });
  expect(readFileSync(join(w.base, "hooks.jsonl"), "utf8")).toContain("pnpm install");
  expect(atResult).toEqual({ turnFile: true, session: true, removed: true });
  expect(readFileSync(join(w.cwd, "turn-1.txt"), "utf8")).toBe("hello");
  expect(existsSync(join(w.cwd, "node_modules"))).toBe(false);
  expect(existsSync(w.mirror(join(w.cwd, "node_modules", "marker")))).toBe(true);
  expect(readFileSync(w.mirror(join(w.configDir, ".credentials.json")), "utf8")).not.toContain("refresh-value");
  engine.stdin.end();
  expect(await closed(engine)).toBe(0);
  expect(w.localLaunches()).toBe(0);
  expect(w.launches()).toHaveLength(1);
}, 60_000);

it("reuses project setup in a new session and continues the same native session back on the home", async () => {
  const w = world();
  const first = w.start(w.plan());
  expect((await turn(first.engine, "one")).reused).toBe(false);
  first.engine.stdin.end();
  await closed(first.engine);
  const second = w.start(w.plan(true), undefined, true);
  const resumed = await turn(second.engine, "two");
  expect(resumed).toMatchObject({ reused: true, sessionLines: 2 });
  second.engine.stdin.end();
  await closed(second.engine);
  const home = w.start(w.plan(true), async () => { throw new Error("computer asleep"); }, true);
  const local = await turn(home.engine, "three");
  expect(home.placed).toEqual(["home"]);
  expect(local).toMatchObject({ sessionLines: 3, cwd: w.cwd });
  expect(readFileSync(w.sessionFile, "utf8").trim().split("\n")).toHaveLength(3);
  home.engine.stdin.end();
  await closed(home.engine);
}, 60_000);

it("stops a running engine on the computer and keeps the work it saved", async () => {
  const w = world();
  const { engine } = w.start(w.plan());
  await turn(engine, "work");
  engine.stdin.write(message("hang"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stopped = killCliTree(engine as unknown as ChildProcess, 2_000);
  expect(await stopped).toBe(true);
  expect(engine.exitCode !== null || engine.signalCode !== null).toBe(true);
  expect(existsSync(join(w.cwd, "turn-1.txt"))).toBe(true);
  expect(existsSync(join(w.remoteBase, "locks"))).toBe(true);
  expect(w.localLaunches()).toBe(0);
}, 60_000);

it("reports an engine crash and keeps what it wrote, without running it again", async () => {
  const w = world();
  const { engine } = w.start(w.plan());
  engine.stdin.write(message("crash"));
  expect(await closed(engine)).toBe(3);
  expect(readFileSync(join(w.cwd, "turn-1.txt"), "utf8")).toBe("crash");
  expect(w.launches()).toHaveLength(1);
  expect(w.localLaunches()).toBe(0);
}, 60_000);

it("fails a turn whose connection drops after launch, never re-runs it, and stops the orphan before the chat starts again", async () => {
  const w = world();
  let relayProcess: ChildProcess | undefined;
  const link = async () => {
    const child = spawn(process.execPath, [RELAY], { env: { ...process.env, LATERDOG_ENGINE_TEST_ROOT: w.remoteRoot }, stdio: ["pipe", "pipe", "pipe"] });
    relayProcess = child;
    const { EventEmitter } = await import("node:events");
    const out = new EventEmitter() as EngineLink;
    createInterface({ input: child.stdout }).on("line", (line) => out.emit("line", line));
    child.on("close", () => out.emit("close", "killed"));
    out.send = (line) => child.stdin.write(`${line}\n`);
    out.close = () => child.kill("SIGKILL");
    return out;
  };
  const { engine } = w.start(w.plan(), link);
  engine.stdin.write(message("hang"));
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const orphan = Number(w.launches()[0]);
  relayProcess!.kill("SIGKILL");
  expect(await closed(engine)).toBe(1);
  expect(await killCliTree(engine as unknown as ChildProcess, 0)).toBe(false);
  expect(w.localLaunches()).toBe(0);
  expect(() => process.kill(orphan, 0)).not.toThrow();
  const again = w.start(w.plan(true), undefined, true);
  await turn(again.engine, "after");
  expect(() => process.kill(orphan, 0)).toThrow();
  again.engine.stdin.end();
  await closed(again.engine);
}, 60_000);

it("runs on the home when the computer surely never started the engine", async () => {
  const w = world();
  const { engine, placed } = w.start(w.plan(), async () => commandLink("/nonexistent/relay", []));
  const result = await turn(engine, "fallback");
  expect(placed).toEqual(["home"]);
  expect(result.cwd).toBe(w.cwd);
  expect(w.localLaunches()).toBe(1);
  engine.stdin.end();
  await closed(engine);
}, 60_000);

it("fails a remote-only engine cleanly when the relay cannot start", async () => {
  const w = world();
  const engine = new EngineProcess(new RemoteSession(commandLink("/nonexistent/relay", []), w.plan().launch));
  running.push(engine);
  const stderr: string[] = [];
  engine.stderr.on("data", bytes => stderr.push(String(bytes)));
  expect(await closed(engine)).toBe(1);
  expect(engine.placement).not.toBe("home");
  expect(stderr.join("")).toContain("closed before it was ready");
  expect(w.launches()).toEqual([]);
}, 60_000);

it("places the engine when the computer takes 95 seconds to wake, because the relay's handshake waits for the link to open", async () => {
  const w = world();
  const waits: EngineWait[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { engine, placed } = w.start(w.plan(), () => new Promise<EngineLink>((resolve) => setTimeout(() => resolve(w.relay()), 95_000)), false, undefined,
    { onWaiting: (wait) => waits.push(wait) });
  await vi.advanceTimersByTimeAsync(95_000);
  vi.useRealTimers();
  const result = await turn(engine, "slow wake");
  expect(placed).toEqual(["computer"]);
  expect(result.cwd).toBe(w.mirror(w.cwd));
  expect(waits).toEqual([{ waiting: true }, { waiting: false, opened: true, waitedMs: expect.any(Number) }]);
  expect(w.localLaunches()).toBe(0);
  engine.stdin.end();
  expect(await closed(engine)).toBe(0);
}, 60_000);

it("runs on the home with the reason when the computer never gets ready within its budget", async () => {
  const w = world();
  const waits: EngineWait[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { engine, placed, reasons } = w.start(w.plan(), () => new Promise<EngineLink>(() => {}), false, undefined,
    { openBudgetMs: 13.5 * 60_000, onWaiting: (wait) => waits.push(wait) });
  await vi.advanceTimersByTimeAsync(13.5 * 60_000);
  vi.useRealTimers();
  const result = await turn(engine, "never woke");
  expect(placed).toEqual(["home"]);
  expect(reasons).toEqual(["The cloud computer did not wake and get ready within 14 minutes."]);
  expect(result.cwd).toBe(w.cwd);
  expect(waits).toEqual([{ waiting: true }, { waiting: false, opened: false, waitedMs: expect.any(Number) }]);
  expect(w.localLaunches()).toBe(1);
  engine.stdin.end();
  await closed(engine);
}, 60_000);

it("stops immediately and cleanly when cancelled while the computer is still waking", async () => {
  const w = world();
  const waits: EngineWait[] = [];
  const planned = w.plan();
  const { engine, placed } = w.start(planned, () => new Promise<EngineLink>(() => {}), false, undefined,
    { onWaiting: (wait) => waits.push(wait), waitNoticeMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(waits).toEqual([{ waiting: true }]);
  const before = Date.now();
  const stopped = await killCliTree(engine as unknown as ChildProcess, 5_000);
  expect(stopped).toBe(true);
  expect(Date.now() - before).toBeLessThan(2_000);
  expect(placed).toEqual([]);
  expect(w.localLaunches()).toBe(0);
  expect(placedThreads.has("thread-1")).toBe(false);
  expect(existsSync(planned.stagingDir)).toBe(false);
  expect(waits).toEqual([{ waiting: true }, { waiting: false, opened: false, waitedMs: expect.any(Number) }]);
}, 60_000);

it("gives the home's always-ask checks to a placed engine and leaves the home's disk guard off it", async () => {
  const GB = 1024 ** 3;
  const nearlyFull = diskRung({ totalBytes: 19.2 * GB, freeBytes: 0.03 * 19.2 * GB });
  const decide = (threadId: string, payload: Record<string, unknown>) => preToolGuardDecision(threadId, {
    signal: () => null,
    homeDisk: () => diskFloorDecision(payload, nearlyFull, { computers: true }),
    homeHeavy: () => null,
    alwaysAsk: () => alwaysAskHook(payload, () => ({ cwd: typeof payload.cwd === "string" ? payload.cwd : undefined, workspaceRoots: [] })),
  });
  const seen: Array<{ placed: boolean; command: unknown }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (bytes) => { body += bytes; });
    req.on("end", () => {
      const payload = JSON.parse(body) as Record<string, unknown>;
      seen.push({ placed: placedThreads.has("thread-1"), command: (payload.tool_input as Record<string, unknown>).command });
      const decision = decide("thread-1", payload);
      res.end(decision ? JSON.stringify({ hookSpecificOutput: decision }) : "");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  const base = realpathSync(mkdtempSync("/tmp/ldguard-"));
  scratch.push(base);
  const guardHook = join(base, "guard-hook.mjs");
  writeFileSync(guardHook, `let text = ""; process.stdin.on("data", (b) => text += b); process.stdin.on("end", async () => { const reply = await fetch(process.env.LATERDOG_HOOK_URL, { method: "POST", body: text }); process.stdout.write(await reply.text()); });\n`);
  const w = world("s-1", { preToolUse: `"${process.execPath}" "${guardHook}"`, env: { LATERDOG_HOOK_URL: url } });
  expect(decide("thread-1", { tool_name: "Bash", tool_input: { command: "pnpm install" } })?.permissionDecision).toBe("deny");
  const { engine, placed } = w.start(w.plan());
  const pushed = await turn(engine, "bash:git push --no-verify origin main");
  expect(placed).toEqual(["computer"]);
  expect(JSON.parse(pushed.preToolUse).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "ask" });
  const heavy = await turn(engine, "bash:pnpm install");
  expect(heavy.preToolUse).toBe("");
  expect(seen).toEqual([{ placed: true, command: "git push --no-verify origin main" }, { placed: true, command: "pnpm install" }]);
  expect(heavy.hookAuthorityVisible).toBe(false);
  engine.stdin.end();
  expect(await closed(engine)).toBe(0);
  expect(placedThreads.has("thread-1")).toBe(false);
  expect(decide("thread-1", { tool_name: "Bash", tool_input: { command: "pnpm install" } })?.permissionDecision).toBe("deny");
}, 60_000);

it("does not run a turn twice when the launch outcome is unknown", async () => {
  const w = world();
  const silent = join(w.base, "silent-relay.mjs");
  writeFileSync(silent, `import { createInterface } from "node:readline"; const say = (v) => process.stdout.write(JSON.stringify(v) + "\\n"); say({ type: "ready" });
createInterface({ input: process.stdin }).on("line", (l) => { const f = JSON.parse(l); if (f.type === "configure") say({ type: "reply", id: f.id, body: { files: [] } }); if (f.type === "prepared") say({ type: "reply", id: f.id, body: { prepared: true } }); if (f.type === "launch") setTimeout(() => process.exit(0), 200); });\n`);
  const { engine, placed } = w.start(w.plan(), async () => commandLink(process.execPath, [silent]));
  engine.stdin.write(message("once"));
  expect(await closed(engine)).toBe(1);
  expect(placed).toEqual(["computer"]);
  expect(w.localLaunches()).toBe(0);
}, 60_000);

it("withholds remote success and preserves the newer home file when a required checkpoint conflicts", async () => {
  const w = world();
  const planned = w.plan();
  planned.launch.requireCompleteCheckpoint = true;
  const { engine, placed } = w.start(planned);
  await turn(engine, "first remote turn");
  const conflict = join(w.cwd, "turn-2.txt");
  writeFileSync(conflict, "newer home file");
  const stdout: string[] = [];
  const stderr: string[] = [];
  engine.stdout.on("data", bytes => stdout.push(String(bytes)));
  engine.stderr.on("data", bytes => stderr.push(String(bytes)));
  engine.stdout.resume();
  const finished = closed(engine);
  engine.stdin.write(message("remote would overwrite it"));
  expect(await finished).toBe(1);
  expect(stdout.join("")).not.toContain('"type":"result"');
  expect(stderr.join("")).toContain("checkpoint could not be committed");
  expect(readFileSync(conflict, "utf8")).toBe("newer home file");
  expect(placed).toEqual(["computer"]);
  expect(w.localLaunches()).toBe(0);
}, 60_000);

it.each(["exit", "disconnect"] as const)("settles a remote %s delivered alongside the launch reply", async (outcome) => {
  const w = world();
  const link = new EventEmitter() as EngineLink;
  const receive = (frame: unknown) => link.emit("line", JSON.stringify(frame));
  link.close = () => { link.emit("close", "relay closed"); };
  link.send = (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "configure") receive({ type: "reply", id: frame.id, body: { files: [] } });
    if (frame.type === "prepared") receive({ type: "reply", id: frame.id, body: { prepared: true } });
    if (frame.type !== "launch") return;
    receive({ type: "reply", id: frame.id, body: { started: true } });
    if (outcome === "disconnect") { link.close(); return; }
    receive({ type: "stdout", data: Buffer.from("native startup output\n").toString("base64") });
    receive({ type: "stderr", data: Buffer.from("native startup failure\n").toString("base64") });
    receive({ type: "native_exit", code: 3 });
  };
  const { engine, placed } = w.start(w.plan(), async () => {
    setImmediate(() => receive({ type: "ready" }));
    return link;
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  engine.stdout.on("data", bytes => stdout.push(String(bytes)));
  engine.stderr.on("data", bytes => stderr.push(String(bytes)));
  expect(await closed(engine)).toBe(outcome === "exit" ? 3 : 1);
  expect(placed).toEqual(["computer"]);
  expect(w.localLaunches()).toBe(0);
  if (outcome === "exit") {
    expect(stdout.join("")).toBe("native startup output\n");
    expect(stderr.join("")).toBe("native startup failure\n");
  } else {
    expect(stderr.join("")).toContain("ended before the engine could be used");
    expect(await killCliTree(engine as unknown as ChildProcess, 0)).toBe(false);
  }
});

it("refuses a second engine for a chat whose engine still runs on the computer", async () => {
  const w = world();
  const first = w.start(w.plan());
  await turn(first.engine, "first");
  const second = w.start(w.plan(true), undefined, true);
  const stderr: string[] = [];
  second.engine.stderr.on("data", (bytes) => stderr.push(String(bytes)));
  expect(await closed(second.engine)).toBe(1);
  expect(stderr.join("")).toContain("not started a second time");
  expect(w.localLaunches()).toBe(0);
  expect(w.launches()).toHaveLength(1);
  first.engine.stdin.end();
  await closed(first.engine);
}, 60_000);

it("mirrors the dog's private folder read-only and bounded, and never brings changes made there back", async () => {
  const w = world();
  const botDir = join(w.base, "data", "workspaces", "bot-1");
  const memory = "# Memory\n- likes tea\n";
  mkdirSync(join(botDir, "memory"), { recursive: true });
  writeFileSync(join(botDir, "MEMORY.md"), memory);
  writeFileSync(join(botDir, "memory", "people.md"), "Ada");
  writeFileSync(join(botDir, "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));
  mkdirSync(join(botDir, "dist"), { recursive: true });
  writeFileSync(join(botDir, "dist", "bundle.js"), "built");
  symlinkSync("/etc/hosts", join(botDir, "hosts"));
  const { engine, placed } = w.start(w.plan());
  await turn(engine, "one");
  expect(placed).toEqual(["computer"]);
  const remote = w.mirror(botDir);
  expect(readFileSync(join(remote, "MEMORY.md"), "utf8")).toBe(memory);
  expect(readFileSync(join(remote, "memory", "people.md"), "utf8")).toBe("Ada");
  expect(statSync(join(remote, "MEMORY.md")).mode & 0o222).toBe(0);
  for (const name of ["huge.bin", "dist/bundle.js", "hosts"]) expect(existsSync(join(remote, name))).toBe(false);
  writeFileSync(join(remote, "made-remotely.md"), "not for the home");
  await turn(engine, "two");
  expect(existsSync(join(botDir, "made-remotely.md"))).toBe(false);
  expect(readFileSync(join(botDir, "MEMORY.md"), "utf8")).toBe(memory);
  engine.stdin.end();
  expect(await closed(engine)).toBe(0);
}, 60_000);

it("renews a near-expiry sign-in on the home during a long remote turn and brings it to the computer without its refresh token", async () => {
  const w = world();
  const planned = w.plan();
  planned.launch.pushEveryMs = 50;
  const ahead = 2 * 3600_000 - 60_000;
  const shifted = () => Date.now() + ahead;
  const renewed: string[] = [];
  const renewer = createClaudeRenewer({ now: shifted, gate: createClaudeRefreshGate({ platform: "linux", now: shifted, pollMs: 5 }), checkMs: 20, run: async (renewal) => {
    renewed.push(renewal.env.CLAUDE_CONFIG_DIR!);
    writeFileSync(join(renewal.env.CLAUDE_CONFIG_DIR!, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "renewed-access", refreshToken: "renewed-refresh", expiresAt: Date.now() + 8 * 3600_000 } }));
    return true;
  } });
  expect(renewer.held()).toEqual([]);
  const { engine, placed } = w.start(planned, undefined, false, renewer);
  engine.stdin.write(message("hang"));
  const remoteCredential = w.mirror(join(w.configDir, ".credentials.json"));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(existsSync(remoteCredential) && readFileSync(remoteCredential, "utf8").includes("renewed-access"))) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(placed).toEqual(["computer"]);
  expect(renewer.held()).toEqual([join(w.configDir, ".credentials.json")]);
  expect(renewed).toEqual([w.configDir]);
  const arrived = readFileSync(remoteCredential, "utf8");
  expect(arrived).toContain("renewed-access");
  expect(arrived).not.toContain("renewed-refresh");
  expect(readFileSync(join(w.configDir, ".credentials.json"), "utf8")).toContain("renewed-refresh");
  expect(await killCliTree(engine as unknown as ChildProcess, 2_000)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(renewer.held()).toEqual([]);
  expect(w.localLaunches()).toBe(0);
}, 60_000);

it("never renews for an engine that ran on the home", async () => {
  const w = world();
  const renewer = createClaudeRenewer({ now: () => Date.now() + 2 * 3600_000, gate: { claim: async () => true }, run: async () => { throw new Error("renewed for a home engine"); } });
  const { engine, placed } = w.start(w.plan(), async () => commandLink("/nonexistent/relay", []), false, renewer);
  await turn(engine, "fallback");
  expect(placed).toEqual(["home"]);
  expect(renewer.held()).toEqual([]);
  engine.stdin.end();
  await closed(engine);
}, 60_000);
