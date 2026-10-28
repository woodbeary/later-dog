import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { PEERS_PROMPT } from "./peer-roster.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const REFUSED = "not an allowed peer";
const TEST_CAPABILITY_KEY = "peer-allowlist-fixture-capability";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let askerDump = "";
let boundDump = "";

const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, dump?: string) => ({
  driver: "claudeAgent",
  displayName,
  environment: { FAKE_CLAUDE_MODE: "happy", ...(dump ? { FAKE_CLAUDE_DUMP: dump } : {}) },
  config: { cli: FAKE_CLAUDE },
});

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "laterdog-peer-allowlist-"));
  const data = join(home, ".laterdog");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Peer allow-list test</title>");
  askerDump = join(home, "asker-dump.json");
  boundDump = join(home, "bound-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      plain: fixture("Plain fixture"),
      asker: fixture("Asker fixture", askerDump),
      bound: fixture("Allow-listed fixture", boundDump),
      stuck: {
        driver: "claudeAgent",
        displayName: "Stuck fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      LATERDOG_SERVER_PORT: String(port),
      LATERDOG_WEBHOOK_PORT: String(port + 1),
      LATERDOG_STATIC_DIR: staticDir,
      LATERDOG_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

const createBot = async (name: string, instanceId: string) =>
  (await api("POST", "/api/bots", {
    name,
    modelSelection: { instanceId, model: "claude-sonnet-5" },
    requireAvailableModel: true,
  })).body.bot;

const readDump = (path: string) => (): { systemPrompt?: string; mcpConfig?: any } | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const botBusy = async (botId: string) => {
  const state = (await api("GET", "/api/bots?messages=0")).body;
  return state.bots.find((bot: { id: string }) => bot.id === botId)?.busy;
};

const botPeers = async (botId: string) => {
  const state = (await api("GET", "/api/bots?messages=0")).body;
  return state.bots.find((bot: { id: string }) => bot.id === botId)?.peers;
};

const mintCapability = async (botId: string, threadId: string): Promise<string> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind: "agents" },
    { "x-laterdog-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return String(minted.body.token);
};

const keepSeededBotOutOfReach = async () => {
  const seeded = (await api("GET", "/api/bots?messages=0")).body.bots[0];
  expect((await api("PATCH", `/api/bots/${seeded.id}`, { visibility: "admins" })).status).toBe(200);
};

const peerNames = async (selfId: string, token: string) => {
  const listed = await api(
    "GET",
    `/api/internal/agents?self=${encodeURIComponent(selfId)}`,
    undefined,
    { authorization: `Bearer ${token}` },
  );
  expect(listed.status).toBe(200);
  return (listed.body.bots as Array<{ name: string }>).map((bot) => bot.name).sort();
};

describe("peer allow-list", () => {
  it("tells an ordinary bot about its peers in one sentence, then narrows list_bots and coordinate_bots", async () => {
    await keepSeededBotOutOfReach();
    const asker = await createBot("Ada", "asker");
    const quill = await createBot("Quill", "plain");
    const patch = await createBot("Patch", "plain");

    try {
      rmSync(askerDump, { force: true });
      expect((await api("POST", `/api/bots/${asker.id}/messages`, { text: "Warm up" })).status).toBe(202);
      await expect.poll(() => readDump(askerDump)()?.systemPrompt, { timeout: 10_000 }).toBeTruthy();
      const dump = readDump(askerDump)()!;

      const systemPrompt = String(dump.systemPrompt);
      expect(systemPrompt).toContain(PEERS_PROMPT);
      expect(systemPrompt).not.toContain("[TEAM ROSTER]");
      expect(systemPrompt).not.toContain("Team availability");
      expect(systemPrompt).not.toMatch(/delegate_bot|ask_bot|send_to_bot/);
      expect(systemPrompt).toContain("make a real dog yourself with create_bot");
      expect(systemPrompt).not.toContain("list_team_setup");

      const providerToken = String(dump.mcpConfig?.mcpServers?.agents?.env?.LATERDOG_COMMS_TOKEN ?? "");
      expect(providerToken).toMatch(/^[a-f0-9]{48}$/);
      await expect.poll(() => botBusy(asker.id)).toBe(false);
      const token = await mintCapability(asker.id, asker.threadId);

      expect(await peerNames(asker.id, token)).toEqual(["Patch", "Quill"]);
      const ask = (toBotId: string, message: string) => api(
        "POST",
        "/api/internal/coordinate-bots",
        { botIds: [toBotId], message },
        { authorization: `Bearer ${token}` },
      );
      const openAsk = await ask(patch.id, "Patch, still there?");
      expect(openAsk.status).toBe(200);
      expect(openAsk.body.receipts).toEqual([expect.objectContaining({ botId: patch.id, outcome: "queued" })]);

      expect((await api("PATCH", `/api/bots/${asker.id}`, { peers: [quill.id] })).status).toBe(200);
      expect(await peerNames(asker.id, token)).toEqual(["Quill"]);

      const refusedAsk = await ask(patch.id, "Patch, one more thing");
      expect(refusedAsk.status).toBe(403);
      expect(String(refusedAsk.body.error)).toContain(REFUSED);

      const allowedAsk = await ask(quill.id, "Quill, still there?");
      expect(allowedAsk.status).toBe(200);
      expect(allowedAsk.body.error).toBeUndefined();
    } finally {
      for (const bot of [asker, quill, patch]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 40_000);

  it("lists only the allow-listed peers to the bot", async () => {
    await keepSeededBotOutOfReach();
    const bound = await createBot("Dot", "bound");
    const near = await createBot("Near", "plain");
    const far = await createBot("Farside", "plain");

    try {
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [near.id] })).status).toBe(200);
      expect(await peerNames(bound.id, await mintCapability(bound.id, bound.threadId))).toEqual(["Near"]);
    } finally {
      for (const bot of [bound, near, far]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 40_000);

  it("refuses to loosen a bot from a bare loopback call while any bot is working", async () => {
    await keepSeededBotOutOfReach();
    const held = await createBot("Held", "stuck");
    const bound = await createBot("Ivy", "plain");
    const peer = await createBot("Ash", "plain");
    const other = await createBot("Elm", "plain");
    const botState = async (id: string) =>
      (await api("GET", "/api/bots?messages=0")).body.bots.find((bot: { id: string }) => bot.id === id);
    const browser = async (path: string, body: unknown) => api("PATCH", path, body, { origin: base });

    try {
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id], approvePeerComms: true, section: "Ops" })).status).toBe(200);
      expect((await api("POST", `/api/bots/${held.id}/messages`, { text: "hold the line" })).status).toBe(202);
      await expect.poll(async () => (await botState(held.id))?.busy, { timeout: 20_000 }).toBe(true);

      const attempts: Array<Record<string, unknown>> = [
        { peers: [peer.id, other.id], acknowledgePeerScope: true },
        { peers: null, acknowledgePeerScope: true },
        { approvePeerComms: false },
        { section: "Finance" },
        { alwaysAllow: ["Bash", "Bash:curl"] },
      ];
      for (const body of attempts) {
        const refused = await api("PATCH", `/api/bots/${bound.id}`, body);
        expect(refused.status, JSON.stringify(body)).toBe(409);
        expect(String(refused.body.error)).toContain("desktop app or a paired device");
      }
      expect(await botState(bound.id)).toMatchObject({ peers: [peer.id], approvePeerComms: true, section: "Ops" });
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [] })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bound.id}`, { name: "Ivy renamed" })).status).toBe(200);
      expect((await browser(`/api/bots/${bound.id}`, { peers: [peer.id], acknowledgePeerScope: true })).status).toBe(200);
      expect((await browser(`/api/bots/${bound.id}`, { section: "Finance" })).status).toBe(200);

      expect((await api("POST", `/api/bots/${held.id}/interrupt`, {})).status).toBe(200);
      await expect.poll(async () => (await botState(held.id))?.busy, { timeout: 20_000 }).toBeFalsy();
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: null, acknowledgePeerScope: true })).status).toBe(200);
      expect(await botPeers(bound.id)).toBeUndefined();
    } finally {
      for (const bot of [held, bound, peer, other]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 60_000);

  it("lets the loopback API narrow a bot's peers but never widen them unacknowledged", async () => {
    await keepSeededBotOutOfReach();
    const bound = await createBot("Ivy", "plain");
    const peer = await createBot("Ash", "plain");
    const other = await createBot("Elm", "plain");

    try {
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id, other.id] })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id] })).status).toBe(200);
      expect(await botPeers(bound.id)).toEqual([peer.id]);

      const readded = await api("PATCH", `/api/bots/${bound.id}`, { peers: [peer.id, other.id] });
      expect(readded.status).toBe(400);
      expect(String(readded.body.error)).toContain("acknowledgePeerScope");
      const cleared = await api("PATCH", `/api/bots/${bound.id}`, { peers: null });
      expect(cleared.status).toBe(400);
      expect(String(cleared.body.error)).toContain("acknowledgePeerScope");
      expect(await botPeers(bound.id)).toEqual([peer.id]);

      const acknowledged = await api("PATCH", `/api/bots/${bound.id}`, {
        peers: [peer.id, other.id],
        acknowledgePeerScope: true,
      });
      expect(acknowledged.status).toBe(200);
      expect(await botPeers(bound.id)).toEqual([peer.id, other.id]);
      expect((await api("PATCH", `/api/bots/${bound.id}`, { peers: null, acknowledgePeerScope: true })).status).toBe(200);
      expect(await botPeers(bound.id)).toBeUndefined();
    } finally {
      for (const bot of [bound, peer, other]) {
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
  }, 60_000);
});
