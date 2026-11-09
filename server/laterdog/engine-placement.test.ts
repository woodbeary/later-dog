import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type WebSocket from "ws";
import { prepareEngineComputer, processStreamLink, type EngineScripts } from "./engine-computer.ts";
import { BOT_FOLDER_FILE_BYTES, botFolderRoot, commandOnPath, ENGINE_PLACEMENT_LOG, notePlacement, planClaudeRemote, remoteEngineBots, remoteEngineChoice, scopedClaudeCredential, setRemoteEngineBot, type ClaudePlacement } from "./engine-placement.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

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
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /app/hooks/laterdog-hook.js", timeout: 5 }] }],
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
  const scoped = JSON.parse(String(scopedClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: 2, expiresAt: Date.now() + 3600_000, scopes: ["x"] } }))));
  expect(scoped).toEqual({ claudeAiOauth: { accessToken: "a", expiresAt: expect.any(Number), scopes: ["x"] } });
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
  expect(settings.hooks.PreToolUse).toBeUndefined();
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

it("puts the relay and the same CLI version on the computer once, and makes the mirrored folders", async () => {
  const { input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  const commands: string[] = []; const written: string[] = [];
  const files = new Set<string>();
  const box = {
    exec: async (command: string) => { commands.push(command); if (command.startsWith("touch")) files.add("ready"); return { exitCode: 0, stdout: command.startsWith("test -f") && files.has("ready") ? "present\n" : "", stderr: "" }; },
    write: async (path: string) => { written.push(path); },
  };
  const relay: EngineScripts = { files: [{ name: "engine-relay.js", bytes: Buffer.from("r") }, { name: "engine-proxy.js", bytes: Buffer.from("p") }], dir: "/home/dog/.laterdog-engine/relay/abc", relay: "/home/dog/.laterdog-engine/relay/abc/engine-relay.js", proxy: "/home/dog/.laterdog-engine/relay/abc/engine-proxy.js" };
  await prepareEngineComputer(box, planned.plan, relay);
  await prepareEngineComputer(box, planned.plan, relay);
  expect(written).toEqual([`${relay.dir}/engine-relay.js`, `${relay.dir}/engine-proxy.js`]);
  expect(commands.filter((command) => command.includes("npm install"))[0]).toContain("'@anthropic-ai/claude-code@2.1.316'");
  const mkdirs = commands.find((command) => command.startsWith("sudo -n install -d -o dog -g dog"))!;
  for (const path of planned.plan.mkdirs) expect(mkdirs).toContain(`'${path}'`);
  const failing = { ...box, exec: async (command: string) => ({ exitCode: command.includes("npm install") ? 1 : 0, stdout: "present", stderr: "" }) };
  await expect(prepareEngineComputer(failing, planned.plan, relay)).rejects.toThrow("could not be installed");
});

it("carries relay lines over the process stream, whole even when a character is split", () => {
  const socket = new EventEmitter() as EventEmitter & { send: (data: string) => void; close: () => void; sent: unknown[] };
  socket.sent = [];
  socket.send = (data) => { socket.sent.push(JSON.parse(data)); };
  socket.close = () => {};
  const link = processStreamLink(socket as unknown as WebSocket, "exec node relay.js");
  expect(socket.sent[0]).toEqual({ channel: "start", input: { command: "exec node relay.js" } });
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

it("gives the home's sign-in renewal the same CLI and the home environment only when a sign-in is lent", () => {
  const { config, input } = setup();
  const planned = planClaudeRemote(input);
  if (!("plan" in planned)) throw new Error(planned.stay);
  expect(planned.plan.renewal).toEqual({ command: input.cliCommand, env: expect.objectContaining({ CLAUDE_CONFIG_DIR: config, HOME: input.env.HOME }) });
  const keyed = planClaudeRemote({ ...input, env: { ...input.env, ANTHROPIC_API_KEY: "sk-ant-fixture" } });
  if (!("plan" in keyed)) throw new Error(keyed.stay);
  expect(keyed.plan.renewal).toBeNull();
});

it("saves a dog's placement atomically, keeps other dogs and fields, and never rewrites a file it cannot read", () => {
  const base = realpathSync(mkdtempSync("/tmp/ldplan-")); scratch.push(base);
  const file = join(base, "remote-engines.json");
  expect(remoteEngineChoice(base, "b1", {})).toEqual({ botId: "b1", computer: false, fromEnvironment: false, workspaceOnComputer: false, heldWorkspaces: 0 });
  writeFileSync(file, JSON.stringify({ bots: ["b2", 7, ""], note: "kept" }));
  expect(setRemoteEngineBot(base, "b1", true, {})).toEqual({ botId: "b1", computer: true, fromEnvironment: false, workspaceOnComputer: false, heldWorkspaces: 0 });
  expect(setRemoteEngineBot(base, "b1", true, {}).computer).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ bots: ["b2", "b1"], note: "kept" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect([...remoteEngineBots(base, {})].sort()).toEqual(["b1", "b2"]);
  expect(setRemoteEngineBot(base, "b1", false, {})).toEqual({ botId: "b1", computer: false, fromEnvironment: false, workspaceOnComputer: false, heldWorkspaces: 0 });
  expect(JSON.parse(readFileSync(file, "utf8")).bots).toEqual(["b2"]);
  expect(remoteEngineChoice(base, "b3", { LATERDOG_REMOTE_ENGINE_BOTS: "b3" })).toEqual({ botId: "b3", computer: true, fromEnvironment: true, workspaceOnComputer: false, heldWorkspaces: 0 });
  writeFileSync(file, "{broken");
  expect(() => setRemoteEngineBot(base, "b1", true, {})).toThrow("left unchanged");
  expect(readFileSync(file, "utf8")).toBe("{broken");
  const fresh = join(base, "fresh");
  expect(setRemoteEngineBot(fresh, "b4", true, {}).computer).toBe(true);
  expect(JSON.parse(readFileSync(join(fresh, "remote-engines.json"), "utf8"))).toEqual({ bots: ["b4"] });
});
