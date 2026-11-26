import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { prepareEngineComputer, processStreamLink, type EngineScripts } from "./engine-computer.ts";
import { BOT_FOLDER_FILE_BYTES, botFolderRoot, commandOnPath, deferredLink, ENGINE_PLACEMENT_LOG, notePlacement, planClaudeRemote, remoteEngineBots, remoteEngineChoice, scopedClaudeCredential, setRemoteEngineBot, type ClaudePlacement } from "./engine-placement.ts";
import { NotDispatched, RemoteSession, type EngineLink } from "./engine-remote.ts";
import { ENGINE_COMPUTER_RESOURCE, engineWaitEvent, watchEngineOpening, type EngineWait } from "./engine-waiting.ts";

const scratch: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function setup(overrides: Partial<ClaudePlacement> = {}, credential: Record<string, unknown> = { accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: 1, expiresAt: Date.now() + 3600_000 }) {
  const base = realpathSync(mkdtempSync("/tmp/ldplan-"));
  scratch.push(base);
  const cwd = join(base, "work"); const config = join(base, "config"); const launch = join(base, "launch");
  const pkg = join(base, "lib", "node_modules", "@anthropic-ai", "claude-code");
  for (const dir of [cwd, config, launch, join(pkg, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.316" }));
  writeFileSync(join(pkg, "bin", "claude"), "");
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: credential }));
  writeFileSync(join(launch, "mcp.json"), JSON.stringify({ mcpServers: {
    agents: { command: "/usr/local/bin/node", args: ["/app/agents-proxy.js"], env: { LATERDOG_TOKEN: "home-token" }, alwaysLoad: true },
    dog: { command: "/usr/local/bin/node", args: ["/app/permission-proxy.js", "/data/perm.sock"] },
  } }));
  writeFileSync(join(launch, "settings.json"), JSON.stringify({ hooks: {
    PreToolUse: ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"].map((matcher) => ({ matcher, hooks: [{ type: "command", command: "node /app/hooks/laterdog-hook.js", timeout: 5 }] })),
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "node /app/hooks/laterdog-hook.js", timeout: 5 }] }],
  }, fastMode: true }));
  writeFileSync(join(launch, "system.txt"), "system prompt");
  const input: ClaudePlacement = {
    botId: "bot", threadId: "thread", sessionId: "11111111-2222-3333-4444-555555555555", cliCommand: join(pkg, "bin", "claude"),
    args: ["-p", "--model", "claude-opus-5-5", "--effort", "high", "--mcp-config", join(launch, "mcp.json"), "--settings", join(launch, "settings.json"), "--system-prompt-file", join(launch, "system.txt")],
    cwd, env: { HOME: base, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin", LATERDOG_HOOK_URL: "http://127.0.0.1:8799/hook", LATERDOG_HOOK_TOKEN_FILE: "/data/t", LATERDOG_REMOTE_MCP_CONFIG_ab: "x", ELECTRON_RUN_AS_NODE: "1" },
    managed: false, dataDir: join(base, "data"), proxyPath: "/home/dog/.laterdog-engine/relay/x/engine-proxy.js", ...overrides,
  };
  return { base, cwd, config, input };
}

it("keeps the engine on the home whenever the launch cannot be mirrored exactly", () => {
  expect(planClaudeRemote(setup({ managed: true }).input)).toEqual({ stay: "managed account" });
  const loopback = setup();
  expect(planClaudeRemote({ ...loopback.input, env: { ...loopback.input.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9000" } })).toEqual({ stay: "account reached through the home" });
  expect(planClaudeRemote(setup({ cliCommand: "/bin/sh" }).input)).toEqual({ stay: "Claude CLI is not an npm install" });
  expect(planClaudeRemote(setup({}, { accessToken: "a", expiresAt: Date.now() + 60_000 }).input)).toEqual({ stay: "no current sign-in to lend" });
  const home = setup();
  expect(planClaudeRemote({ ...home.input, cwd: home.base })).toEqual({ stay: "working folder cannot be mirrored" });
});

it("finds the npm Claude CLI when the home launches it by bare name through PATH, as a Linux Cloud home does", () => {
  const { base, input } = setup();
  const bin = join(base, "bin");
  mkdirSync(bin);
  symlinkSync(input.cliCommand, join(bin, "claude"));
  const planned = planClaudeRemote({ ...input, cliCommand: "claude", env: { ...input.env, PATH: `/nonexistent:${bin}:/usr/bin` } });
  if (!("plan" in planned)) throw new Error(planned.stay);
  expect(planned.plan.cli).toEqual({ name: "@anthropic-ai/claude-code", version: "2.1.316" });
  expect(planClaudeRemote({ ...input, cliCommand: "claude", env: { ...input.env, PATH: "/usr/bin" } })).toEqual({ stay: "Claude CLI is not an npm install" });
  expect(commandOnPath("./claude", bin)).toBeNull();
});

it("keeps each placement decision in a capped log in the home's data folder", () => {
  const { base } = setup();
  notePlacement(base, "[engine] bot thread stays on the home: why", new Date("2026-11-09T06:00:00Z"));
  expect(readFileSync(join(base, ENGINE_PLACEMENT_LOG), "utf8")).toBe("2026-11-09T06:00:00.000Z [engine] bot thread stays on the home: why\n");
  writeFileSync(join(base, ENGINE_PLACEMENT_LOG), "x".repeat(300 * 1024) + "\nold line\n");
  notePlacement(base, "new line");
  const kept = readFileSync(join(base, ENGINE_PLACEMENT_LOG), "utf8");
  expect(kept.length).toBeLessThan(200 * 1024);
  expect(kept.endsWith("new line\n")).toBe(true);
});

it("lends the computer an access token but never the refresh token", () => {
  const scoped = JSON.parse(String(scopedClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: 2, expiresAt: Date.now() + 3600_000, scopes: ["x"], addedAuthority: "secret" } }))));
  expect(scoped).toEqual({ claudeAiOauth: { accessToken: "a", expiresAt: expect.any(Number), scopes: ["x"] } });
});

it("keeps inherited home and store credentials out of both remote launch environments", () => {
  const { input } = setup();
  const settings = input.args[input.args.indexOf("--settings") + 1];
  const authority = {
    LATERDOG_CLOUD_BOOTSTRAP_SECRET: "fixture-bootstrap",
    LATERDOG_CLOUD_ARCHIVE_TOKEN: "fixture-archive",
    LATERDOG_STATE_TOKEN: "fixture-store",
    LATERDOG_CLOUD_BOAT_TOKEN: "fixture-computer-admin",
    AWS_SECRET_ACCESS_KEY: "fixture-other-provider",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "fixture-refresh",
    LC_SECRET: "fixture-disguised-secret",
  };
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), env: { ...authority, ANTHROPIC_AUTH_TOKEN: "fixture-model-token" } }));
  const planned = planClaudeRemote({ ...input, env: { ...input.env, ...authority, LC_ALL: "C.UTF-8", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" } });
  if (!("plan" in planned)) throw new Error(planned.stay);
  const { launch } = planned.plan;
  const settingsForComputer = JSON.parse(readFileSync(launch.args[launch.args.indexOf("--settings") + 1], "utf8"));
  for (const name of Object.keys(authority)) expect(launch.env[name]).toBeUndefined();
  expect(settingsForComputer.env).toEqual({ ANTHROPIC_AUTH_TOKEN: "fixture-model-token" });
  expect(launch.env).toMatchObject({ LC_ALL: "C.UTF-8", CLAUDE_CODE_SUBAGENT_MODEL: "haiku" });
  expect(launch.hookEnv.LATERDOG_HOOK_TOKEN_FILE).toBe("/data/t");
  expect(launch.pushes).toBeUndefined();

  writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://localhost:8799" } }));
  expect(planClaudeRemote(input)).toEqual({ stay: "account reached through the home" });
  writeFileSync(settings, JSON.stringify({ apiKeyHelper: "read-home-credential" }));
  expect(planClaudeRemote(input)).toEqual({ stay: "account requires the home's credential provider" });
});

it.each(["physical", "legacy"])("places a resumed Claude account in the %s workspace that owns its native transcript", (spelling) => {
  const { base, cwd, config, input } = setup();
  const alias = join(base, "workspace-alias");
  symlinkSync(cwd, alias, "dir");
  const native = spelling === "physical" ? cwd : alias;
  const sessionId = "a15cf3dd-3672-4248-8e17-e384c464d3c2";
  const project = join(config, "projects", native.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${sessionId}.jsonl`), "prior session");
  const result = planClaudeRemote({ ...input, cwd: alias, sessionId });
  if (!("plan" in result)) throw Error(result.stay);
  expect(result.plan.launch.cwd).toBe(native);
  expect(result.plan.launch.roots.find(root => root.id === "session")?.path).toBe(project);
});

it("mirrors the same model, effort and session, and keeps tools, hooks and their secrets on the home", () => {
  const { cwd, config, input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  const { launch, cli } = planned.plan;
  expect(cli).toEqual({ name: "@anthropic-ai/claude-code", version: "2.1.316" });
  expect(launch.args.slice(0, 5)).toEqual(["-p", "--model", "claude-opus-5-5", "--effort", "high"]);
  expect(launch.cwd).toBe(cwd);
  const mcp = JSON.parse(readFileSync(launch.args[launch.args.indexOf("--mcp-config") + 1], "utf8")).mcpServers;
  expect(mcp.agents).toEqual({ command: "node", args: [input.proxyPath, "mcp", launch.socketPath, "agents"], alwaysLoad: true });
  expect(JSON.stringify(mcp)).not.toContain("home-token");
  expect(launch.mcp.agents.env).toEqual({ LATERDOG_TOKEN: "home-token" });
  expect(launch.mcp.dog.args).toEqual(["/app/permission-proxy.js", "/data/perm.sock"]);
  const settings = JSON.parse(readFileSync(launch.args[launch.args.indexOf("--settings") + 1], "utf8"));
  expect(settings.hooks.PreToolUse.map((entry: { matcher: string }) => entry.matcher)).toEqual(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
  for (const entry of settings.hooks.PreToolUse) expect(entry.hooks[0]).toEqual({ type: "command", command: `node ${input.proxyPath} hook 0`, timeout: 30 });
  expect(settings.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: `node ${input.proxyPath} hook 0`, timeout: 30 });
  expect(settings.fastMode).toBe(true);
  expect(launch.hooks).toEqual(["node /app/hooks/laterdog-hook.js"]);
  expect(readFileSync(launch.args[launch.args.indexOf("--system-prompt-file") + 1], "utf8")).toBe("system prompt");
  expect(Object.keys(launch.env).filter((key) => key.startsWith("LATERDOG_") || key === "ELECTRON_RUN_AS_NODE")).toEqual([]);
  expect(launch.env.CLAUDE_CONFIG_DIR).toBe(config);
  expect(launch.hookEnv.LATERDOG_HOOK_TOKEN_FILE).toBe("/data/t");
  expect(launch.roots.find((root) => root.id === "session")).toMatchObject({ path: join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-")), files: [`${input.sessionId}.jsonl`] });
  expect(launch.outputIds).toEqual(["workspace", "session", "session-extra", "file-history"]);
  const pushed = launch.pushes!();
  expect(pushed.map((file) => [file.root, file.path])).toEqual([["credential", ".credentials.json"]]);
  expect(String(pushed[0].bytes)).not.toContain("\"r\"");
});

it("reads the chosen dogs from the environment and the data folder", () => {
  const base = realpathSync(mkdtempSync("/tmp/ldplan-")); scratch.push(base);
  writeFileSync(join(base, "remote-engines.json"), JSON.stringify({ bots: ["b2"] }));
  expect([...remoteEngineBots(base, { LATERDOG_REMOTE_ENGINE_BOTS: "b1, ," })].sort()).toEqual(["b1", "b2"]);
  expect([...remoteEngineBots(join(base, "missing"), {})]).toEqual([]);
});

function fakeComputer(options: { failWith?: number } = {}) {
  const commands: string[] = []; const written: string[] = [];
  let ready = false;
  const box = {
    exec: async (command: string, timeoutMs = 600_000) => {
      if (timeoutMs > 600_000) throw new Error("Cloud computer command timeout exceeds 600000ms");
      commands.push(command);
      if (command.startsWith("touch")) { ready = true; return { exitCode: 0, stdout: "", stderr: "" }; }
      if (options.failWith) return { exitCode: options.failWith, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: ready ? "relay-present\n" : "", stderr: "" };
    },
    write: async (path: string) => { written.push(path); },
  };
  return { box, commands, written };
}

const relayScripts: EngineScripts = { files: [{ name: "engine-relay.js", bytes: Buffer.from("r") }, { name: "engine-proxy.js", bytes: Buffer.from("p") }], dir: "/home/dog/.laterdog-engine/relay/abc", relay: "/home/dog/.laterdog-engine/relay/abc/engine-relay.js", proxy: "/home/dog/.laterdog-engine/relay/abc/engine-proxy.js" };

it("puts the relay and the same CLI version on the computer once, and makes the mirrored folders", async () => {
  const { input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  const { box, commands, written } = fakeComputer();
  await prepareEngineComputer(box, planned.plan, relayScripts);
  expect(written).toEqual([`${relayScripts.dir}/engine-relay.js`, `${relayScripts.dir}/engine-proxy.js`]);
  expect(commands).toHaveLength(2);
  const script = commands[0]!;
  expect(script).toContain("'@anthropic-ai/claude-code@2.1.316'");
  expect(script).toContain(`test -x '/home/dog/.laterdog-engine/cli/claude-code-2.1.316/node_modules/.bin/claude'`);
  expect(script).toContain("--allow-build='@anthropic-ai/claude-code'");
  expect(script).toContain("--version");
  expect(script).toContain("2.1.316 (Claude Code)");
  expect(script).toContain("/@anthropic-ai/claude-code/install.cjs");
  expect(script).toContain("sudo -n install -d -o dog -g dog -m 700");
  for (const path of planned.plan.mkdirs) expect(script).toContain(`'${path}'`);
  expect(script).toContain(`test -f '${relayScripts.dir}/.ready'`);
  expect(commands[1]).toBe(`touch '${relayScripts.dir}/.ready'`);
});

it("prepares a warm computer in one round trip and still checks the CLI, the folders and the relay", async () => {
  const { input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  const { box, commands, written } = fakeComputer();
  await prepareEngineComputer(box, planned.plan, relayScripts);
  commands.length = 0; written.length = 0;
  await prepareEngineComputer(box, planned.plan, relayScripts);
  expect(commands).toHaveLength(1);
  expect(written).toEqual([]);
  expect(commands[0]).toMatch(/corepack pnpm@10[\s\S]*sudo -n install -d[\s\S]*\.ready/);
});

it("names what failed while preparing the computer", async () => {
  const { input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  await expect(prepareEngineComputer(fakeComputer({ failWith: 41 }).box, planned.plan, relayScripts)).rejects.toThrow("Claude Code 2.1.316 could not be installed");
  await expect(prepareEngineComputer(fakeComputer({ failWith: 42 }).box, planned.plan, relayScripts)).rejects.toThrow("mirrored folders could not be made");
  await expect(prepareEngineComputer(fakeComputer({ failWith: 1 }).box, planned.plan, relayScripts)).rejects.toThrow("could not be prepared");
  const unmarked = fakeComputer();
  const box = { ...unmarked.box, exec: async (command: string) => command.startsWith("touch") ? { exitCode: 1, stdout: "", stderr: "" } : unmarked.box.exec(command) };
  await expect(prepareEngineComputer(box, planned.plan, relayScripts)).rejects.toThrow("relay could not be put");
  const noisy = fakeComputer();
  const noisyBox = { ...noisy.box, exec: async (command: string) => command.startsWith("touch") ? noisy.box.exec(command) : { exitCode: 0, stdout: "not-relay-present\n", stderr: "" } };
  await prepareEngineComputer(noisyBox, planned.plan, relayScripts);
  expect(noisy.written).toEqual([`${relayScripts.dir}/engine-relay.js`, `${relayScripts.dir}/engine-proxy.js`]);
});

function fakeLink() {
  const link = new EventEmitter() as EngineLink & { sent: string[]; closed: boolean };
  link.sent = []; link.closed = false;
  link.send = (line) => { link.sent.push(line); };
  link.close = () => { link.closed = true; };
  return link;
}

it("opens the deferred link only once the computer is ready, keeps what was sent meanwhile, and says so", async () => {
  vi.useFakeTimers();
  let ready!: (link: EngineLink) => void;
  const link = deferredLink(new Promise<EngineLink>((resolve) => { ready = resolve; }), 15 * 60_000);
  const events: string[] = [];
  link.on("open", () => events.push("open"));
  link.on("close", (why) => events.push(`close ${why}`));
  expect(link.opening).toBe(true);
  link.send("early");
  await vi.advanceTimersByTimeAsync(95_000);
  const real = fakeLink();
  ready(real);
  await vi.advanceTimersByTimeAsync(0);
  expect(link.opening).toBe(false);
  expect(events).toEqual(["open"]);
  expect(real.sent).toEqual(["early"]);
  link.send("late");
  expect(real.sent).toEqual(["early", "late"]);
  real.emit("line", "{}");
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  expect(events).toEqual(["open"]);
});

it("closes a deferred link with the reason when the computer fails or never gets ready within its budget", async () => {
  vi.useFakeTimers();
  const failed = deferredLink(Promise.reject(new Error("The dog's cloud computer could not start.")), 60_000);
  const failure: string[] = [];
  failed.on("close", (why) => failure.push(why));
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toEqual(["The dog's cloud computer could not start."]);
  const late = fakeLink();
  let ready!: (link: EngineLink) => void;
  const stuck = deferredLink(new Promise<EngineLink>((resolve) => { ready = resolve; }), 13.5 * 60_000);
  const closes: string[] = [];
  stuck.on("close", (why) => closes.push(why));
  await vi.advanceTimersByTimeAsync(13.5 * 60_000);
  expect(closes).toEqual(["The cloud computer did not wake and get ready within 14 minutes."]);
  ready(late);
  await vi.advanceTimersByTimeAsync(0);
  expect(late.closed).toBe(true);
  expect(stuck.opening).toBe(true);
  let resolveCancelled!: (link: EngineLink) => void;
  const boot = new AbortController();
  const cancelled = deferredLink(new Promise<EngineLink>((resolve) => { resolveCancelled = resolve; }), 60_000, () => boot.abort());
  const cancelCloses: string[] = [];
  cancelled.on("close", (why) => cancelCloses.push(why));
  cancelled.close();
  expect(boot.signal.aborted).toBe(true);
  expect(cancelCloses).toEqual(["closed before the computer was ready"]);
  const arrivedLate = fakeLink();
  resolveCancelled(arrivedLate);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(arrivedLate.closed).toBe(true);
  expect(cancelCloses).toEqual(["closed before the computer was ready"]);
});

it("arms the relay handshake timeout only after the link opens and cleans up listeners", async () => {
  vi.useFakeTimers();
  const { input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  const opening = fakeLink();
  opening.opening = true;
  const session = new RemoteSession(opening, planned.plan.launch);
  const started = session.start();
  const outcome = started.then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(90_000);
  opening.opening = false;
  opening.emit("open");
  await vi.advanceTimersByTimeAsync(29_000);
  opening.emit("line", JSON.stringify({ type: "ready" }));
  await vi.advanceTimersByTimeAsync(2_000);
  opening.emit("close", "done");
  await outcome;
  const silent = fakeLink();
  silent.opening = true;
  const timedOut = new RemoteSession(silent, planned.plan.launch);
  const timeoutOutcome = timedOut.start().then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(90_000);
  silent.opening = false;
  silent.emit("open");
  await vi.advanceTimersByTimeAsync(30_000);
  const err = await timeoutOutcome;
  expect(err).toBeInstanceOf(NotDispatched);
  expect((err as Error).message).toContain("did not answer");
  const aborted = fakeLink();
  aborted.opening = true;
  new RemoteSession(aborted, planned.plan.launch);
  expect(aborted.listenerCount("open")).toBe(1);
  aborted.emit("close", "cancelled");
  expect(aborted.listenerCount("open")).toBe(0);
});

it("tells the chat it is waiting on the computer only when opening takes a while, and when the wait ends", async () => {
  vi.useFakeTimers();
  let clock = 0;
  const waits: EngineWait[] = [];
  const quick = fakeLink(); quick.opening = true;
  watchEngineOpening(quick, (wait) => waits.push(wait), 2_000, () => clock);
  clock = 500; quick.opening = false; quick.emit("open");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(waits).toEqual([]);
  const slow = fakeLink(); slow.opening = true;
  watchEngineOpening(slow, (wait) => waits.push(wait), 2_000, () => clock);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(waits).toEqual([{ waiting: true }]);
  clock = 95_500; slow.emit("open");
  expect(waits).toEqual([{ waiting: true }, { waiting: false, opened: true, waitedMs: 95_000 }]);
  const lost = fakeLink(); lost.opening = true;
  watchEngineOpening(lost, (wait) => waits.push(wait), 2_000, () => clock);
  await vi.advanceTimersByTimeAsync(2_000);
  lost.emit("close", "gone");
  expect(waits.at(-1)).toEqual({ waiting: false, opened: false, waitedMs: 0 });
  const open = fakeLink();
  watchEngineOpening(open, (wait) => waits.push(wait), 0);
  await vi.advanceTimersByTimeAsync(10);
  expect(waits).toHaveLength(4);
  expect(engineWaitEvent({ waiting: true })).toEqual({ type: "turn.wait_started", resource: ENGINE_COMPUTER_RESOURCE });
  expect(engineWaitEvent({ waiting: false, opened: true, waitedMs: 9 })).toEqual({ type: "turn.wait_ended", resource: ENGINE_COMPUTER_RESOURCE, waitedMs: 9, outcome: "acquired" });
  expect(engineWaitEvent({ waiting: false, opened: false, waitedMs: 9 })).toMatchObject({ outcome: "gave_up" });
});

it("carries relay lines over the process stream, whole even when a character is split", () => {
  const socket = new EventEmitter() as EventEmitter & { send: (data: string) => void; close: () => void; sent: unknown[] };
  socket.sent = [];
  socket.send = (data) => { socket.sent.push(JSON.parse(data)); };
  socket.close = () => {};
  const link = processStreamLink(socket as unknown as WebSocket, "exec node relay.js");
  expect(socket.sent[0]).toEqual({ channel: "start", lifetime: "engine", input: { command: "exec node relay.js" } });
  const lines: string[] = []; let closed = "";
  link.on("line", (line) => lines.push(line));
  link.on("close", (why) => { closed = why; });
  const bytes = Buffer.from("{\"text\":\"é\"}\nnext");
  socket.emit("message", JSON.stringify({ channel: "stdout", data: bytes.subarray(0, 10).toString("base64") }));
  socket.emit("message", JSON.stringify({ channel: "stdout", data: bytes.subarray(10).toString("base64") }));
  socket.emit("message", JSON.stringify({ channel: "ping" }));
  expect(lines).toEqual(["{\"text\":\"é\"}"]);
  expect(socket.sent.at(-1)).toEqual({ channel: "pong" });
  link.send("{\"type\":\"stop\"}");
  expect(socket.sent.at(-1)).toEqual({ channel: "stdin", data: Buffer.from("{\"type\":\"stop\"}\n").toString("base64") });
  socket.emit("message", JSON.stringify({ channel: "exit", code: 0 }));
  expect(closed).toBe("relay exited 0");
});

it("lends the dog's private folder read-only and bounded, never overlapping the working folder or the account", () => {
  const { base, cwd, config, input } = setup();
  const botDir = join(input.dataDir, "workspaces", "bot");
  mkdirSync(join(botDir, "memory"), { recursive: true });
  writeFileSync(join(botDir, "MEMORY.md"), "# Memory");
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  const root = planned.plan.launch.roots.find((entry) => entry.id === "bot")!;
  expect(root).toEqual({ id: "bot", path: botDir, writable: false, readOnly: true, bounded: { fileBytes: BOT_FOLDER_FILE_BYTES, totalBytes: 64 * 1024 * 1024, exclude: [] } });
  expect(BOT_FOLDER_FILE_BYTES).toBe(8 * 1024 * 1024);
  expect(planned.plan.launch.outputIds).not.toContain("bot");
  expect(planned.plan.mkdirs).toContain(botDir);
  const staging = planned.plan.stagingDir;
  expect(botFolderRoot(input.dataDir, "missing", cwd, config, staging)).toBeNull();
  expect(botFolderRoot(input.dataDir, "../bot", cwd, config, staging)).toBeNull();
  expect(botFolderRoot(input.dataDir, "bot", botDir, config, staging)).toBeNull();
  expect(botFolderRoot(input.dataDir, "bot", base, config, staging)).toBeNull();
  expect(botFolderRoot(input.dataDir, "bot", cwd, join(botDir, "config"), staging)).toBeNull();
  expect(botFolderRoot(input.dataDir, "bot", join(botDir, "projects", "site"), config, staging)?.bounded?.exclude).toEqual(["projects/site"]);
  rmSync(botDir, { recursive: true });
  symlinkSync(cwd, botDir);
  expect(botFolderRoot(input.dataDir, "bot", join(base, "elsewhere"), config, staging)).toBeNull();
});

it("saves a dog's placement atomically, keeps other dogs and fields, and never rewrites a file it cannot read", () => {
  const base = realpathSync(mkdtempSync("/tmp/ldplan-")); scratch.push(base);
  const file = join(base, "remote-engines.json");
  expect(remoteEngineChoice(base, "b1", {})).toEqual({ botId: "b1", computer: false, fromEnvironment: false });
  writeFileSync(file, JSON.stringify({ bots: ["b2", 7, ""], note: "kept" }));
  expect(setRemoteEngineBot(base, "b1", true, {})).toEqual({ botId: "b1", computer: true, fromEnvironment: false });
  expect(setRemoteEngineBot(base, "b1", true, {}).computer).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bots: ["b2", "b1"], note: "kept" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect([...remoteEngineBots(base, {})].sort()).toEqual(["b1", "b2"]);
  expect(setRemoteEngineBot(base, "b1", false, {})).toEqual({ botId: "b1", computer: false, fromEnvironment: false });
  expect(JSON.parse(readFileSync(file, "utf8")).bots).toEqual(["b2"]);
  expect(remoteEngineChoice(base, "b3", { LATERDOG_REMOTE_ENGINE_BOTS: "b3" })).toEqual({ botId: "b3", computer: true, fromEnvironment: true });
  writeFileSync(file, "{broken");
  expect(() => setRemoteEngineBot(base, "b1", true, {})).toThrow("left unchanged");
  expect(readFileSync(file, "utf8")).toBe("{broken");
  const fresh = join(base, "fresh");
  expect(setRemoteEngineBot(fresh, "b4", true, {}).computer).toBe(true);
  expect(JSON.parse(readFileSync(join(fresh, "remote-engines.json"), "utf8"))).toEqual({ bots: ["b4"] });
});

it("puts the exact CLI first, then computer-owned package bins, independently of the home's PATH", () => {
  const { input } = setup();
  for (const hostPath of ["/host/credentials/bin:/malicious/bin", "/data/home/.local/bin:/tmp/attacker", ""]) {
    const planned = planClaudeRemote({ ...input, env: { ...input.env, PATH: hostPath } });
    if (!("plan" in planned)) throw new Error(planned.stay);
    const { launch } = planned.plan;
    const cliBin = launch.cli.slice(0, launch.cli.lastIndexOf("/"));
    expect(launch.env.PATH?.split(":")).toEqual([cliBin, "/home/dog/.local/bin", "/home/dog/.npm-global/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
    expect(launch.env.PATH).not.toContain(hostPath || "/tmp/attacker");
    expect(launch.env.HOME).toBe("/home/dog");
    expect(launch.env.LATERDOG_HOOK_TOKEN_FILE).toBeUndefined();
  }
});
