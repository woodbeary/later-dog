import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { killCliTree } from "../procs.ts";
import { claudeProjectSlug, planClaudeRemote, spawnPlacedEngine, type ClaudeRemotePlan } from "./engine-placement.ts";
import { commandLink, type EngineLink } from "./engine-remote.ts";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const RELAY = here("./engine-relay.ts");
const PROXY = here("./engine-proxy.ts");
const FAKE = here("../testing/fake-remote-engine.ts");
const scratch: string[] = [];
const running: Array<{ kill(): unknown }> = [];
afterEach(() => {
  for (const child of running.splice(0)) try { child.kill(); } catch {}
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function world(sessionId = "s-1") {
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
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `"${process.execPath}" "${hookScript}"`, timeout: 5 }] }] } }));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: configDir, FAKE_ENGINE_SLUG: claudeProjectSlug(cwd),
    FAKE_ENGINE_LAUNCHES: join(base, "launches.txt"), LATERDOG_HOOK_TOKEN_FILE: join(base, "token"),
  };
  const args = (resume: boolean) => ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", mcpPath, "--settings", settingsPath, resume ? "--resume" : "--session-id", sessionId];
  const plan = (resume = false) => {
    const planned = planClaudeRemote({ botId: "bot-1", threadId: "thread-1", sessionId, cliCommand: join(pkg, "bin", "claude"), args: args(resume), cwd, env,
      managed: false, dataDir: join(base, "data"), proxyPath: PROXY, remoteBase });
    if (!("plan" in planned)) throw new Error(planned.stay);
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
  const start = (planned: ClaudeRemotePlan, link: () => Promise<EngineLink> = async () => relay(), resume = false) => {
    const placed: string[] = [];
    const engine = spawnPlacedEngine(planned, link, local(resume), (where) => placed.push(where));
    running.push(engine);
    return { engine, placed };
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
