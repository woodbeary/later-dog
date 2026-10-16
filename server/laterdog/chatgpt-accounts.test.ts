import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexDeviceAuthController } from "../drivers/codex-device-auth.ts";
import type { InstanceConfigMap } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fixtureCodexLogin } from "../testing/fake-ai-logins.ts";
import { removableAccount, renamableAccount } from "./account-edit.ts";
import { forgetAccountFolder, ownedAccountFolder } from "./account-folder.ts";
import { CODEX_FILE_STORE, newChatGptAccount } from "./chatgpt-accounts.ts";

const UUID = "0f6c5a52-8d1e-4c3b-9a7e-2b1d0c9e8f7a";

const FAKE_CODEX = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2).join(' ');
appendFileSync(join(process.env.HOME, 'calls.jsonl'), JSON.stringify({ args, codexHome: process.env.CODEX_HOME }) + '\\n');
const login = join(process.env.CODEX_HOME, 'auth.json');
if (args === 'login status') {
  process.stderr.write(existsSync(login) ? 'Logged in using ChatGPT\\n' : 'Not logged in\\n');
  process.exit(existsSync(login) ? 0 : 1);
} else if (args === 'login --device-auth') {
  console.error('Offline later.dog fixture. Open this link:');
  console.error('https://auth.openai.com/codex/device');
  console.error('Enter this one-time code (expires in 15 minutes)');
  console.error('FIXT-URE00');
  setTimeout(() => { writeFileSync(login, process.env.FIXTURE_LOGIN, { mode: 0o600 }); console.error('Successfully logged in'); process.exit(0); }, 80);
} else process.exit(4);
`;

describe("adding a ChatGPT account", () => {
  let root: string;
  let dataDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "laterdog-chatgpt-accounts-"));
    dataDir = join(root, "data", ".laterdog");
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(async () => { await removeTempDir(root); });

  const existing = (): InstanceConfigMap => ({
    codex: { driver: "codex", config: { cli: "/opt/codex" } },
    chatgpt: { driver: "codex", displayName: "ChatGPT plan", config: { authMode: "chatgpt-plan" } },
  });

  it("on a Mac keeps the ChatGPT plan sign-in it has always used", () => {
    const { instanceId, instances } = newChatGptAccount(existing(), "Personal", { cloudHome: false, dataDir, newId: () => UUID });
    expect(instanceId).toBe(`chatgpt-${UUID}`);
    expect(instances[instanceId]).toEqual({ driver: "codex", displayName: "Personal", config: { authMode: "chatgpt-plan", cli: "/opt/codex" } });
    expect(existsSync(join(dataDir, "providers"))).toBe(false);
  });

  it("on a Cloud home makes a Codex account with its own private folder under the data folder, signed in with a device code", async () => {
    const { instanceId, instances } = newChatGptAccount(existing(), "Anthony's ChatGPT", { cloudHome: true, dataDir, newId: () => UUID });
    const folder = join(dataDir, "providers", `codex-${UUID}`);
    expect(instanceId).toBe(`codex-${UUID}`);
    expect(instances[instanceId]).toEqual({ driver: "codex", displayName: "Anthony's ChatGPT", environment: { CODEX_HOME: folder }, config: { cli: "/opt/codex" } });
    expect(instances.codex).toEqual(existing().codex);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(folder, "config.toml"), "utf8")).toBe(CODEX_FILE_STORE);
    expect(statSync(join(folder, "config.toml")).mode & 0o777).toBe(0o600);
    expect(renamableAccount(instances[instanceId])).toEqual({ ok: true });
    expect(removableAccount(instanceId, instances[instanceId])).toEqual({ ok: true });

    const cli = join(root, "fake-codex.mjs");
    writeFileSync(cli, FAKE_CODEX, { mode: 0o700 });
    chmodSync(cli, 0o700);
    const login = JSON.stringify(fixtureCodexLogin(7));
    const controller = new CodexDeviceAuthController({
      cli, environment: () => ({ ...process.env, HOME: join(root, "data"), ...instances[instanceId].environment, FIXTURE_LOGIN: login }),
      startupTimeoutMs: 10_000, lifetimeMs: 15_000, terminateTimeoutMs: 50,
    });
    try {
      const start = await controller.start();
      expect(start).toMatchObject({ phase: "waiting", authorizationUrl: "https://auth.openai.com/codex/device", userCode: "FIXT-URE00" });
      await expect.poll(() => controller.get(start.flowId!), { timeout: 5_000 }).toMatchObject({ phase: "succeeded" });
    } finally {
      await controller.dispose();
    }
    expect(readFileSync(join(folder, "auth.json"), "utf8")).toBe(login);
    expect(existsSync(join(root, "data", ".codex"))).toBe(false);
    const seen = readFileSync(join(root, "data", "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { codexHome: string });
    expect(seen.every((call) => call.codexHome === folder)).toBe(true);
  });
});

describe("removing an account", () => {
  let root: string;
  let dataDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "laterdog-account-folder-"));
    dataDir = join(root, ".laterdog");
  });
  afterEach(async () => { await removeTempDir(root); });

  const folderWith = (id: string, files: string[]) => {
    const folder = join(dataDir, "providers", id);
    mkdirSync(folder, { recursive: true });
    for (const file of files) writeFileSync(join(folder, file), "fixture", { mode: 0o600 });
    return folder;
  };

  it("deletes the saved login and the hand-over marker kept in the account's own folder", () => {
    const claude = folderWith(`claude-${UUID}`, [".credentials.json", "handoff.json", ".claude.json"]);
    const codex = folderWith(`codex-${UUID}`, ["auth.json", "config.toml", "handoff.json"]);
    const neighbour = folderWith("claude-2", [".credentials.json"]);
    expect(forgetAccountFolder(dataDir, `claude-${UUID}`, { driver: "claudeAgent", config: { configDir: claude } })).toBe(true);
    expect(forgetAccountFolder(dataDir, `codex-${UUID}`, { driver: "codex", environment: { CODEX_HOME: codex } })).toBe(true);
    expect(existsSync(claude)).toBe(false);
    expect(existsSync(codex)).toBe(false);
    expect(existsSync(join(neighbour, ".credentials.json"))).toBe(true);
    expect(forgetAccountFolder(dataDir, `claude-${UUID}`, { driver: "claudeAgent", config: { configDir: claude } })).toBe(false);
  });

  it("never deletes a folder the account only points at: the person's own CLI folder, another account's or one chosen by hand", () => {
    const own = join(root, ".claude");
    mkdirSync(own);
    writeFileSync(join(own, ".credentials.json"), "fixture");
    const other = folderWith("claude-2", [".credentials.json"]);
    const named = folderWith("claude-3", [".credentials.json"]);
    expect(ownedAccountFolder(dataDir, "claude-3", { driver: "claudeAgent", config: { configDir: own } })).toBeNull();
    expect(forgetAccountFolder(dataDir, "claude-3", { driver: "claudeAgent", config: { configDir: own } })).toBe(false);
    expect(forgetAccountFolder(dataDir, "claude-3", { driver: "claudeAgent", config: { configDir: other } })).toBe(false);
    expect(forgetAccountFolder(dataDir, "codex-3", { driver: "codex" })).toBe(false);
    expect(forgetAccountFolder(dataDir, "claude-3", { driver: "grokAgent" })).toBe(false);
    expect(forgetAccountFolder(dataDir, "..", { driver: "codex", environment: { CODEX_HOME: dataDir } })).toBe(false);
    expect(forgetAccountFolder(dataDir, "chatgpt-1", { driver: "codex", config: { authMode: "chatgpt-plan" } })).toBe(false);
    expect(existsSync(join(own, ".credentials.json"))).toBe(true);
    expect(existsSync(join(other, ".credentials.json"))).toBe(true);
    expect(existsSync(join(named, ".credentials.json"))).toBe(true);
  });

  it("keeps the Codex login on the person's own computer from being renamed, and names a Cloud one", () => {
    expect(renamableAccount({ driver: "codex", config: {} }).ok).toBe(false);
    expect(renamableAccount({ driver: "codex", environment: { CODEX_HOME: "/data/providers/codex" } }).ok).toBe(true);
  });
});
