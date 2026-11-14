import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../../../scripts/control-laterdog.ts";
import { spawnWithSecrets } from "../../../../server/cloud-home-start.ts";
import { waitForExit } from "../../../../server/testing/cleanup.ts";
import { FolderAwayCoordinator, folderAwayBridge } from "../../../../server/laterdog/folder-away.ts";
import { AWAY_RULES, type AwayPlan } from "../../../../server/laterdog/folder-away-plan.ts";
import { createArchiver, serveArchive } from "../runtime/archive.mjs";
import { createFolderAway, MARKER } from "../runtime/folder-away.mjs";

const TOKEN = "folder-away-fixture";
const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const OLD = new Date(Date.UTC(2026, 8, 1));

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, OLD, OLD);
}

function memory() {
  const blobs = new Map<string, Uint8Array>();
  let index: unknown = null;
  const state = { unavailable: false, attempts: 0 };
  return {
    state,
    async archiveIndex() { return structuredClone(index); },
    async putArchiveIndex(next: unknown) { index = structuredClone(next); },
    async hasArchived(hash: string) { return blobs.has(hash); },
    async putArchived(hash: string, bytes: Uint8Array) { blobs.set(hash, new Uint8Array(bytes)); },
    async getArchived(hash: string) {
      state.attempts++;
      if (state.unavailable) throw new Error("fixture outage");
      const found = blobs.get(hash);
      if (!found) throw new Error("missing");
      return found;
    },
  };
}

describe("the server and the runtime together", () => {
  it("moves an idle chat away on the sweep and brings it back whole before use, waiting out an outage", async () => {
    const root = mkdtempSync(join(tmpdir(), "folder-away-together-"));
    made.push(root);
    const tasksDir = join(root, "task-workspaces");
    const dir = join(tasksDir, "dog-1", "chat-old");
    put(join(dir, "notes.md"), "the plan");
    put(join(dir, "src", "app.ts"), "export const answer = 42;\n");
    const store = memory();
    const folders = createFolderAway({ tasksDir, ledgerDir: join(root, "folders-away"), store, freeBytes: async () => 1e12, retryMs: 1 });
    const service = await serveArchive(createArchiver({ root, store }), { token: TOKEN, folders });
    try {
      const plan: AwayPlan = {
        at: 0, tookMs: 0, complete: true, disk: null, underPressure: false, rules: AWAY_RULES,
        totals: { folders: 1, bytes: 0, away: 0, byTimer: { chats: 1, bytes: 1 }, byPressure: { chats: 0, bytes: 0, passes: 0 } }, projected: null,
        chats: [{ botId: "dog-1", threadId: "chat-old", bytes: 1, carriedBytes: 1, leftOutBytes: 0, files: 2, lastUsedAt: 0, newestAt: 0, verdict: "moves" }],
      };
      const exists = new Set(["chat-old"]);
      const coordinator = new FolderAwayCoordinator({
        bridge: folderAwayBridge(service.url, TOKEN), tasksDir, enabled: () => true,
        chat: (_botId, threadId) => ({ exists: exists.has(threadId), inUse: false }),
        plan: async () => plan, disk: () => ({ totalBytes: 100, freeBytes: 90 }), retryMs: 5, maxRetryMs: 10,
      });
      await coordinator.sweep();
      expect(readdirSync(dir)).toEqual([MARKER]);
      expect(await coordinator.status()).toMatchObject({ away: 1 });
      expect(coordinator.report().line).toMatch(/^1 chat's files are kept in Cloud storage/);
      store.state.unavailable = true;
      const back = coordinator.ensureChatFolder("dog-1", "chat-old");
      await expect.poll(() => store.state.attempts, { timeout: 5000 }).toBeGreaterThan(6);
      expect(readdirSync(dir)).toEqual([MARKER]);
      store.state.unavailable = false;
      expect(await back).toBe(true);
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("the plan");
      expect(readFileSync(join(dir, "src", "app.ts"), "utf8")).toBe("export const answer = 42;\n");
      await coordinator.sweep();
      expect(readdirSync(dir)).toContain("notes.md");
      await folders.move("dog-1", "chat-old");
      exists.delete("chat-old");
      expect(await coordinator.releaseRemoved()).toBe(1);
      expect(readFileSync(join(root, "folders-away", "released.ndjson"), "utf8")).toContain("\"threadId\":\"chat-old\"");
    } finally {
      await service.close();
    }
  });
});

it("a turn and the app's file route both wait for a chat's files to come back", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  let service: { url: string; close(): Promise<void> } | undefined;
  const api = async (path: string, init?: RequestInit) => {
    const response = await fetch(url + path, { signal: AbortSignal.timeout(5000), ...init });
    expect(response.ok, `${path} answered ${response.status}`).toBe(true);
    return response;
  };
  try {
    const { bot } = await runControlLaterDog(["new-bot", "--name", "Folder away fixture", "--url", url]) as any;
    const id = bot.activeTaskId;
    await expect.poll(async () => {
      const bots = await (await api("/api/bots")).json();
      return bots.bots.find((value: any) => value.id === bot.id).tasks.find((value: any) => value.threadId === id).busy;
    }, { timeout: 30_000 }).toBe(false);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const home = join(dataDir, ".laterdog");
    mkdirSync(home);
    for (const name of readdirSync(dataDir)) {
      if (name === ".laterdog" || name === "tmp") continue;
      cpSync(join(dataDir, name), join(home, name), { recursive: true });
    }
    const chatDir = join(home, "task-workspaces", bot.id, id);
    const notes = join(chatDir, "notes.md");
    put(notes, "FOLDER_AWAY_FIXTURE_NOTES");
    const prompts = join(dataDir, "folder-prompts.jsonl");
    const configPath = join(home, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_PROMPTS: prompts, FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify([`The notes are in [notes.md](${notes})`]) };
    writeFileSync(configPath, JSON.stringify(config));
    const store = memory();
    const folders = createFolderAway({ tasksDir: join(home, "task-workspaces"), ledgerDir: join(home, "folders-away"), store, freeBytes: async () => 1e12, retryMs: 1 });
    expect(await folders.move(bot.id, id)).toMatchObject({ moved: true });
    service = await serveArchive(createArchiver({ root: dataDir, store }), { token: TOKEN, folders });
    const log = openSync(logPath, "a", 0o600);
    const env = { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), LATERDOG_HOME: home, LATERDOG_CLOUD_ARCHIVE_URL: service.url, LATERDOG_CLOUD_SECRETS_FD: "3" };
    server = spawnWithSecrets(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../../../../server/index.ts", import.meta.url))],
      env, { LATERDOG_CLOUD_ARCHIVE_TOKEN: TOKEN }, { stdio: ["ignore", log, log] });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);

    store.state.unavailable = true;
    const before = store.state.attempts;
    await runControlLaterDog(["send", "--bot", bot.id, "--task", id, "--text", "FOLDER_AWAY_TURN", "--url", url]);
    await expect.poll(() => store.state.attempts, { timeout: 15_000 }).toBeGreaterThan(before + 5);
    expect(existsSync(prompts)).toBe(false);
    expect(readdirSync(chatDir)).toEqual([MARKER]);
    store.state.unavailable = false;
    await expect.poll(() => existsSync(prompts) ? readFileSync(prompts, "utf8") : "", { timeout: 60_000 }).toContain("FOLDER_AWAY_TURN");
    expect(readFileSync(notes, "utf8")).toBe("FOLDER_AWAY_FIXTURE_NOTES");

    let reply: any;
    await expect.poll(async () => {
      const page = await (await api(`/api/threads/${id}/messages`)).json();
      reply = (page.messages ?? []).findLast((message: any) => message.role === "bot" && message.kind === "text" && String(message.text).includes(notes));
      return Boolean(reply);
    }, { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => {
      const bots = await (await api("/api/bots")).json();
      return bots.bots.find((value: any) => value.id === bot.id).tasks.find((value: any) => value.threadId === id).busy;
    }, { timeout: 30_000 }).toBe(false);
    expect(await folders.move(bot.id, id)).toMatchObject({ moved: true });
    expect(readdirSync(chatDir)).toEqual([MARKER]);
    const file = await api(`/api/threads/${id}/messages/${reply.id}/file`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: notes }) });
    expect(await file.text()).toBe("FOLDER_AWAY_FIXTURE_NOTES");
    expect(readFileSync(notes, "utf8")).toBe("FOLDER_AWAY_FIXTURE_NOTES");
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await service?.close();
    await fixture.close();
  }
}, 180_000);
