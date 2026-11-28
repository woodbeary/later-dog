import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { resetPathCacheForTests } from "../env-path.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { ClaudeTasks } from "./claude-tasks.ts";
import { setEngineOpener, type ClaudeRemotePlan } from "../laterdog/engine-placement.ts";
import * as placement from "../laterdog/engine-placement.ts";
import { commandLink } from "../laterdog/engine-remote.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, "..", "testing", "fake-claude-cli.ts");
const RELAY = join(here, "..", "laterdog", "engine-relay.ts");
const PROXY = join(here, "..", "laterdog", "engine-proxy.ts");
const scratch: string[] = [];
afterEach(() => {
  setEngineOpener(null);
  delete process.env.LATERDOG_REMOTE_ENGINE_BOTS;
  delete process.env.FAKE_CLAUDE_DUMP;
  vi.restoreAllMocks();
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fakePackage(at: string): string {
  const pkg = join(at, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.316" }));
  writeFileSync(join(pkg, "bin", "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(pkg, "bin", "claude"), 0o755);
  return join(pkg, "bin", "claude");
}

function fakeRelay(plan: ClaudeRemotePlan, remoteRoot: string) {
  const controls = Object.entries(plan.launch.hookEnv).filter(([name]) => name.startsWith("FAKE_CLAUDE_"));
  Object.assign(plan.launch.env, Object.fromEntries(controls));
  return commandLink(process.execPath, [RELAY], { ...process.env, LATERDOG_ENGINE_TEST_ROOT: remoteRoot });
}

it("keeps a required cloud turn off the home when its computer is unavailable", async () => {
  ensureDirs();
  const base = realpathSync(mkdtempSync("/tmp/ldclaude-required-"));
  scratch.push(base);
  const config = join(base, "config");
  const cwd = join(base, "work");
  for (const dir of [config, cwd]) mkdirSync(dir);
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt: Date.now() + 3600_000 } }));
  const dump = join(base, "local-prompt.json");
  process.env.FAKE_CLAUDE_DUMP = dump;
  vi.spyOn(placement, "remoteEngineChoice").mockImplementation((_dir, botId) => ({ botId, computer: true, fromEnvironment: false, required: true }));
  const open = vi.fn(async () => { throw new Error("The fixture computer is offline."); });
  setEngineOpener({ proxyPath: PROXY, open });
  const instance = await ClaudeDriver.create({ instanceId: "claude-required", displayName: "Claude", enabled: true,
    environment: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_VERSION: "2.1.316" }, config: { cli: fakePackage(join(base, "lib")), permissionMode: "auto" } });
  onTestFinished(() => instance.dispose());
  const recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId: "required-thread", botId: "required-dog", text: "local execution would write the dump", cwd });
  const done = await recorder.until(event => event.type === "turn.completed");
  expect(done).toMatchObject({ ok: false });
  expect(recorder.events.some(event => event.type === "runtime.error" && event.message.includes("offline"))).toBe(true);
  expect(open).toHaveBeenCalledTimes(1);
  expect(existsSync(dump)).toBe(false);
  const missing = "11111111-2222-4333-8444-555555555555";
  await expect(instance.adapter.sendTurn({ threadId: "required-legacy", botId: "required-dog", text: "never rebuild silently",
    resumeCursor: missing, recoveryText: "partial context", cwd })).rejects.toThrow("saved Claude session is missing");
  expect(open).toHaveBeenCalledTimes(1);
  expect(existsSync(dump)).toBe(false);
}, 30_000);

it("generates auxiliary text on its owning computer with the selected model, usage and no chat tools", async () => {
  ensureDirs();
  const base = realpathSync(mkdtempSync("/tmp/ldclaude-helper-"));
  scratch.push(base);
  const config = join(base, "config");
  const remoteRoot = join(base, "remote");
  const remoteBase = join(base, "rb");
  for (const dir of [config, remoteRoot]) mkdirSync(dir);
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture", expiresAt: Date.now() + 3600_000 } }));
  vi.spyOn(placement, "remoteEngineChoice").mockImplementation((_dir, botId) => ({ botId, computer: true, fromEnvironment: false, required: true }));
  const bin = join(remoteBase, "cli", "claude-code-2.1.316", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(fakePackage(join(base, "remote-cli")), join(bin, "claude"));
  const launches: string[] = [];
  setEngineOpener({ proxyPath: PROXY, remoteBase, open: async (dog, plan) => {
    launches.push(dog);
    expect(plan.launch.outputIds).toEqual([]);
    expect(plan.launch.roots.map(root => root.id)).toEqual(["workspace", "account", "launch", "credential"]);
    expect(plan.launch.roots[0]).toMatchObject({ files: [], writable: false });
    expect(plan.launch.mcp).toEqual({});
    expect(plan.launch.args).toEqual(expect.arrayContaining(["--no-session-persistence", "--tools", "", "--strict-mcp-config"]));
    mkdirSync(remoteRoot + plan.launch.cwd, { recursive: true });
    return fakeRelay(plan, remoteRoot);
  } });
  const provider = await ClaudeDriver.create({ instanceId: "claude-helper", displayName: "Claude", enabled: true,
    environment: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_VERSION: "2.1.316" }, config: { cli: fakePackage(join(base, "home-cli")), permissionMode: "auto" } });
  onTestFinished(() => provider.dispose());
  const usage = vi.fn();
  await expect(provider.generateText!("name this conversation", { model: "haiku", botId: "helper-owner", onUsage: usage })).resolves.toBe("fake generated text");
  expect(usage).toHaveBeenCalledWith(expect.objectContaining({ model: "haiku" }));
  await expect(provider.generateText!("missing owner")).rejects.toThrow("requires the dog");
  await expect(provider.generateText!("cancelled", { botId: "helper-owner", signal: AbortSignal.abort() })).rejects.toThrow("aborted");
  expect(launches).toEqual(["helper-owner"]);
}, 30_000);

it("runs a chosen dog's Claude turn on its computer with the same model and session, and leaves other dogs on the home", async () => {
  ensureDirs();
  const base = realpathSync(mkdtempSync("/tmp/ldclaude-"));
  scratch.push(base);
  const cwd = join(base, "work"); const config = join(base, "config"); const remoteRoot = join(base, "remote"); const remoteBase = join(base, "rb");
  for (const dir of [cwd, config, remoteRoot]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, "brief.md"), "from home");
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 } }));
  const cli = fakePackage(join(base, "lib"));
  const remoteBin = join(remoteBase, "cli", "claude-code-2.1.316", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const opened: string[] = [];
  setEngineOpener({ proxyPath: PROXY, remoteBase, open: async (botId, plan) => { opened.push(botId); return fakeRelay(plan, remoteRoot); } });
  process.env.LATERDOG_REMOTE_ENGINE_BOTS = "dog-remote";
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.join(" ")); });

  const instance = await ClaudeDriver.create({ instanceId: "claude-remote", displayName: "Claude", enabled: true,
    environment: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_VERSION: "2.1.316" }, config: { cli, permissionMode: "acceptEdits" } });
  const recorder = recordEvents(instance.adapter);
  const dump = join(base, "remote-dump.json");
  process.env.FAKE_CLAUDE_DUMP = dump;
  await instance.adapter.sendTurn({ threadId: "remote-thread", botId: "dog-remote", text: "Hello there", cwd, model: "claude-opus-5-5", effort: "high" } as never);
  const done = await recorder.until((event) => event.type === "turn.completed" && event.threadId === "remote-thread");
  expect((done as { ok?: boolean }).ok).toBe(true);
  const seen = JSON.parse(readFileSync(dump, "utf8"));
  expect(opened).toEqual(["dog-remote"]);
  expect(seen.cwd).toBe(`${remoteRoot}${cwd}`);
  expect(seen.argv[seen.argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  expect(seen.argv).toContain("--effort");
  expect(seen.argv).toContain("--session-id");
  expect(seen.mcpConfig.mcpServers.dog.args.slice(0, 2)).toEqual([PROXY, "mcp"]);
  expect(seen.env.LATERDOG_HOOK_TOKEN_FILE).toBeUndefined();
  expect(existsSync(`${remoteRoot}${cwd}/brief.md`)).toBe(true);
  expect(logs.some((line) => line.includes("runs on the dog's cloud computer"))).toBe(true);
  expect(logs.find((line) => line.includes("runs on the dog's cloud computer"))).toMatch(/start: link [\d.]+ s, files listed [\d.]+ s, configured [\d.]+ s, \d+ files \([\d.]+ MB\) sent [\d.]+ s, launched [\d.]+ s/);

  const homeDump = join(base, "home-dump.json");
  process.env.FAKE_CLAUDE_DUMP = homeDump;
  await instance.adapter.sendTurn({ threadId: "home-thread", botId: "dog-home", text: "Hi", cwd } as never);
  await recorder.until((event) => event.type === "turn.completed" && event.threadId === "home-thread");
  expect(JSON.parse(readFileSync(homeDump, "utf8")).cwd).toBe(cwd);
  expect(opened).toEqual(["dog-remote"]);
  await instance.dispose?.();
}, 60_000);

it("places a dog launched by bare name through PATH, as on a Linux Cloud home, and moves a warm engine when its placement changes", async () => {
  ensureDirs();
  const base = realpathSync(mkdtempSync("/tmp/ldclaude-"));
  scratch.push(base);
  const cwd = join(base, "work"); const config = join(base, "config"); const remoteRoot = join(base, "remote"); const remoteBase = join(base, "rb"); const bin = join(base, "bin");
  for (const dir of [cwd, config, remoteRoot, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 } }));
  const bare = `claude-ldtest-${process.pid}`;
  symlinkSync(fakePackage(join(base, "lib")), join(bin, bare));
  const remoteBin = join(remoteBase, "cli", "claude-code-2.1.316", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const opened: string[] = [];
  setEngineOpener({ proxyPath: PROXY, remoteBase, open: async (botId, plan) => { opened.push(botId); return fakeRelay(plan, remoteRoot); } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  const pathBefore = process.env.PATH;
  process.env.PATH = `${bin}:${pathBefore}`;
  resetPathCacheForTests();
  onTestFinished(() => { process.env.PATH = pathBefore; resetPathCacheForTests(); });

  const instance = await ClaudeDriver.create({ instanceId: "claude-bare", displayName: "Claude", enabled: true,
    environment: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_VERSION: "2.1.316" }, config: { cli: bare, permissionMode: "acceptEdits" } });
  const recorder = recordEvents(instance.adapter);
  let turns = 0;
  let resumeCursor: string | undefined;
  const turn = async () => {
    const dump = join(base, `dump-${++turns}.json`);
    process.env.FAKE_CLAUDE_DUMP = dump;
    await instance.adapter.sendTurn({ threadId: "warm-thread", botId: "dog-warm", text: `turn ${turns}`, cwd, model: "claude-opus-5-5", resumeCursor } as never);
    const done = await recorder.until((event) => event.type === "turn.completed" && event.threadId === "warm-thread" && recorder.events.filter((e) => e.type === "turn.completed" && e.threadId === "warm-thread").length === turns);
    expect((done as { ok?: boolean }).ok, JSON.stringify(recorder.events.filter((e) => e.threadId === "warm-thread").slice(-6))).toBe(true);
    return existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) : null;
  };

  const first = await turn();
  expect(first.cwd).toBe(cwd);
  resumeCursor = (recorder.events.find((event) => event.type === "session.started" && event.threadId === "warm-thread") as { sessionId?: string }).sessionId;
  expect(resumeCursor).toBeTruthy();
  expect(await turn()).toBeNull();
  expect(opened).toEqual([]);

  process.env.LATERDOG_REMOTE_ENGINE_BOTS = "dog-warm";
  const moved = await turn();
  expect(opened).toEqual(["dog-warm"]);
  expect(moved.cwd).toBe(`${remoteRoot}${cwd}`);
  expect(moved.argv[moved.argv.indexOf("--resume") + 1]).toBe(resumeCursor);

  delete process.env.LATERDOG_REMOTE_ENGINE_BOTS;
  const back = await turn();
  expect(back.cwd).toBe(cwd);
  expect(back.argv[back.argv.indexOf("--resume") + 1]).toBe(resumeCursor);
  expect(opened).toEqual(["dog-warm"]);
  await instance.dispose?.();
}, 60_000);

it("drains the old account before a second account launches the same remote thread and keeps same-account reuse", async () => {
  ensureDirs();
  const base = realpathSync(mkdtempSync("/tmp/ldclaude-"));
  scratch.push(base);
  const cwd = join(base, "work"); const config = join(base, "config"); const remoteRoot = join(base, "remote"); const remoteBase = join(base, "rb");
  for (const dir of [cwd, config, remoteRoot]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, "brief.md"), "from home");
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 } }));
  const cli = fakePackage(join(base, "lib"));
  const remoteBin = join(remoteBase, "cli", "claude-code-2.1.316", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const opened: string[] = [];
  const locks: string[] = [];
  setEngineOpener({ proxyPath: PROXY, remoteBase, open: async (botId, plan) => {
    opened.push(botId);
    const link = fakeRelay(plan, remoteRoot);
    const send = link.send;
    link.send = (line) => {
      const frame = JSON.parse(line);
      if (frame.type === "configure") {
        expect(existsSync(frame.lockFile), "the previous relay released its lock before launch").toBe(false);
        locks.push(frame.lockFile);
      }
      send(line);
    };
    return link;
  } });
  process.env.LATERDOG_REMOTE_ENGINE_BOTS = "dog-handoff";
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logs.push(parts.join(" ")); });


  const instances: Awaited<ReturnType<typeof ClaudeDriver.create>>[] = [];
  const environments: Record<string, string>[] = [];
  for (const name of ["first", "second"]) {
    const configDir = join(base, name);
    mkdirSync(configDir);
    writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: name, expiresAt: Date.now() + 3600_000 } }));
    const environment = { CLAUDE_CONFIG_DIR: configDir, FAKE_CLAUDE_VERSION: "2.1.316", FAKE_CLAUDE_STAYS_AFTER_INPUT: "1", FAKE_CLAUDE_EXIT_DELAY_MS: "300" };
    environments.push(environment);
    instances.push(await ClaudeDriver.create({ instanceId: name, displayName: name, enabled: true,
      environment,
      config: { cli, permissionMode: "acceptEdits" } }));
  }
  onTestFinished(async () => { for (const instance of instances) await instance.dispose?.(); });
  const turn = { threadId: "account-handoff", botId: "dog-handoff", text: "hello", cwd, model: "claude-opus-5-5" };
  const recorders = instances.map((instance) => recordEvents(instance.adapter));
  const send = async (account: number, threadId = turn.threadId) => {
    const { turnId } = await instances[account].adapter.sendTurn({ ...turn, threadId } as never);
    const done = await recorders[account].until((event) => event.type === "turn.completed" && event.turnId === turnId, 25_000);
    expect((done as { ok?: boolean }).ok, JSON.stringify(recorders[account].events.slice(-8))).toBe(true);
  };
  await send(0);
  await send(0);
  expect(opened).toEqual(["dog-handoff"]);
  await send(0, "unrelated-thread");
  const unrelatedLock = readFileSync(locks[1], "utf8");
  await send(1);
  expect(opened).toHaveLength(3);
  expect(readFileSync(locks[1], "utf8")).toBe(unrelatedLock);
  const helper = vi.spyOn(ClaudeTasks.prototype, "running").mockReturnValue(true);
  const priorLock = readFileSync(locks[2], "utf8");
  try {
    await expect(instances[0].adapter.sendTurn(turn as never)).rejects.toThrow("still working");
    expect(readFileSync(locks[2], "utf8")).toBe(priorLock);
    expect(opened).toHaveLength(3);
  } finally { helper.mockRestore(); }
  await send(1);
  expect(opened).toHaveLength(3);
  environments[0].FAKE_CLAUDE_MODE = "hang";
  const activeTurn = { ...turn, threadId: "active-thread" };
  const running = await instances[0].adapter.sendTurn(activeTurn as never);
  await recorders[0].until((event) => event.type === "session.started" && event.threadId === activeTurn.threadId);
  const activeLock = readFileSync(locks[3], "utf8");
  await expect(instances[1].adapter.sendTurn(activeTurn as never)).rejects.toThrow("still working");
  expect(readFileSync(locks[3], "utf8")).toBe(activeLock);
  expect(opened).toHaveLength(4);
  await instances[0].adapter.interruptTurn(activeTurn.threadId);
  await recorders[0].until((event) => event.type === "turn.completed" && event.turnId === running.turnId);
  expect(recorders.flatMap((recorder) => recorder.events).some((event) => event.type === "runtime.error")).toBe(false);
}, 60_000);
