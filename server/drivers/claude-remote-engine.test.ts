import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { setEngineOpener } from "../laterdog/engine-placement.ts";
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

function fakePackage(base: string, at: string): string {
  const pkg = join(at, "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.316" }));
  writeFileSync(join(pkg, "bin", "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(pkg, "bin", "claude"), 0o755);
  return join(pkg, "bin", "claude");
}

it("runs a chosen dog's Claude turn on its computer with the same model and session, and leaves other dogs on the home", async () => {
  ensureDirs();
  const base = realpathSync(mkdtempSync("/tmp/ldclaude-"));
  scratch.push(base);
  const cwd = join(base, "work"); const config = join(base, "config"); const remoteRoot = join(base, "remote"); const remoteBase = join(base, "rb");
  for (const dir of [cwd, config, remoteRoot]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, "brief.md"), "from home");
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 } }));
  const cli = fakePackage(base, join(base, "lib"));
  const remoteBin = join(remoteBase, "cli", "claude-code-2.1.316", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const opened: string[] = [];
  setEngineOpener({ proxyPath: PROXY, remoteBase, open: async (botId) => { opened.push(botId); return commandLink(process.execPath, [RELAY], { ...process.env, LATERDOG_ENGINE_TEST_ROOT: remoteRoot }); } });
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

  // A dog that is not chosen stays on the home.
  const homeDump = join(base, "home-dump.json");
  process.env.FAKE_CLAUDE_DUMP = homeDump;
  await instance.adapter.sendTurn({ threadId: "home-thread", botId: "dog-home", text: "Hi", cwd } as never);
  await recorder.until((event) => event.type === "turn.completed" && event.threadId === "home-thread");
  expect(JSON.parse(readFileSync(homeDump, "utf8")).cwd).toBe(cwd);
  expect(opened).toEqual(["dog-remote"]);
  await instance.dispose?.();
}, 60_000);
