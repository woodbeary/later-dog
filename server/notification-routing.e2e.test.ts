import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";


const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "notification-routing-fixture-capability";

let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let dumpFile = "";

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
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};

const capability = async (
  botId: string,
  threadId: string,
  kind: "agents" | "computer" = "agents",
): Promise<Record<string, string>> => {
  const minted = await api(
    "POST",
    "/api/testing/internal-capability",
    { botId, threadId, kind },
    { "x-laterdog-test-capability": TEST_CAPABILITY_KEY },
  );
  expect(minted.status).toBe(201);
  return { authorization: `Bearer ${minted.body.token}` };
};

const state = async (messages = 40) => (await api("GET", `/api/bots?messages=${messages}`)).body;
const botState = async (botId: string) =>
  (await state(40)).bots.find((candidate: { id: string }) => candidate.id === botId);
const groupState = async (groupId: string) =>
  (await state(40)).groups.find((candidate: { id: string }) => candidate.id === groupId);

const createBot = async (name: string, instanceId: string, model = "claude-sonnet-5") => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, {
    name,
    notifications: true,
    modelSelection: { instanceId, model },
  });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (groupIds: Array<string | undefined>, botIds: string[]) => {
  for (const groupId of groupIds) {
    if (groupId) await api("POST", `/api/groups/${groupId}/interrupt`, {}).catch(() => undefined);
  }
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const groupId of groupIds) {
    if (groupId) await api("DELETE", `/api/groups/${groupId}`).catch(() => undefined);
  }
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "laterdog-notification-routing-"));
  const data = join(home, ".laterdog");
  mkdirSync(data, { recursive: true });
  dumpFile = join(home, "quick-dump.json");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      quick: {
        driver: "claudeAgent",
        displayName: "Quick fixture",
        environment: { FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: dumpFile },
        config: { cli: FAKE_CLAUDE },
      },
      stuck: {
        driver: "claudeAgent",
        displayName: "Stuck fixture",
        environment: { FAKE_CLAUDE_MODE: "hang" },
        config: { cli: FAKE_CLAUDE },
      },
      curious: {
        driver: "grokAgent",
        displayName: "Curious fixture",
        environment: { FAKE_ACP_MODE: "question" },
        config: { cli: FAKE_ACP, fullAuto: true },
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
      LATERDOG_ASK_BOT_TIMEOUT_MS: "6000",
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

}, 45_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

describe("an ordinary turn still announces itself", () => {
  it("badges the bot and banners the person when a person asked", async () => {
    const bot = await createBot("Herald", "quick");
    const stream = await openSse(`${base}/api/events`);
    try {
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "how did it go?" })).status).toBe(202);

      const frame = await stream.until(
        (candidate) =>
          candidate.kind === "notify" &&
          candidate.notification?.kind === "done" &&
          candidate.notification?.botId === bot.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ threadId: bot.threadId, title: "Herald finished" });
      expect(frame.notification.body).toContain("hello from fake claude");
      expect(frame.notification.groupId).toBeUndefined();
      await expect.poll(async () => (await botState(bot.id))?.unread, { timeout: 20_000 }).toBe(true);
    } finally {
      stream.close();
      await cleanup([], [bot.id]);
    }
  }, 40_000);
});

describe("a room turn belongs to the room", () => {
  it("leaves the speaking bot's own thread unread-free while the room lights up", async () => {
    const bot = await createBot("Roomie", "quick");
    let roomId: string | undefined;
    try {
      const room = (await api("POST", "/api/groups", {
        name: "Standup",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "status?" })).status).toBe(202);

      await expect.poll(async () => {
        const current = await groupState(room.id);
        const replied = (current?.messages ?? []).some(
          (message: { kind: string; role?: string }) => message.kind === "text" && message.role === "bot",
        );
        return { working: current?.working, replied };
      }, { timeout: 20_000 }).toEqual({ working: false, replied: true });

      expect((await groupState(room.id))?.unread).toBe(true);
      expect((await botState(bot.id))?.unread).toBeFalsy();
    } finally {
      await cleanup([roomId], [bot.id]);
    }
  }, 40_000);

  it("sends a takeover raised mid-room to the room, not to the bot's DM", async () => {
    const bot = await createBot("Handsy", "stuck");
    let roomId: string | undefined;
    let requestId: string | undefined;
    try {
      const room = (await api("POST", "/api/groups", {
        name: "War Room",
        memberIds: [bot.id],
        setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
      })).body.group;
      roomId = room.id;
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "take the wheel" })).status).toBe(202);
      await expect.poll(async () => (await groupState(room.id))?.busyBotId, { timeout: 20_000 }).toBe(bot.id);

      const stream = await openSse(`${base}/api/events`);
      try {
        const asked = await api(
          "POST",
          `/api/internal/computer-control?botId=${bot.id}`,
          { reason: "the login page wants a code" },
          await capability(bot.id, room.threadId, "computer"),
        );
        expect(asked.status).toBe(200);
        requestId = asked.body.requestId;

        const frame = await stream.until(
          (candidate) => candidate.kind === "notify" && candidate.notification?.kind === "takeover",
          15_000,
        );
        expect(frame.notification).toMatchObject({
          botId: bot.id,
          threadId: room.threadId,
          groupId: room.id,
          title: "Handsy in War Room needs your hands",
          body: "the login page wants a code",
        });
        expect(frame.notification.threadId).not.toBe(bot.threadId);
      } finally {
        stream.close();
      }
    } finally {
      if (requestId) {
        await api(
          "DELETE",
          `/api/internal/computer-control?botId=${bot.id}`,
          { requestId },
          await capability(bot.id, roomId ? (await groupState(roomId)).threadId : bot.threadId, "computer"),
        ).catch(() => undefined);
      }
      await cleanup([roomId], [bot.id]);
    }
  }, 45_000);
});

describe("a dog asking another dog", () => {
  it("records the coordinate_bots exchange with no badge and no banner for the exchange or the teammate", async () => {
    const asker = await createBot("Pen", "quick");
    const peer = await createBot("Ink", "quick");
    let channelId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    try {
      const asked = await api(
        "POST",
        "/api/internal/coordinate-bots",
        { botIds: [peer.id], message: "Ink, can you take the deploy?" },
        await capability(asker.id, asker.threadId),
      );
      expect(asked.status, JSON.stringify(asked.body)).toBe(200);
      const exchange = async () => (await state(40)).groups.find(
        (group: { dm?: boolean; memberIds: string[] }) =>
          group.dm === true && group.memberIds.includes(asker.id) && group.memberIds.includes(peer.id),
      );
      await expect.poll(async () => ((await exchange())?.messages ?? []).some(
        (message: { from?: { botId?: string }; text?: string }) =>
          message.from?.botId === peer.id && (message.text ?? "").includes("hello from fake claude"),
      ), { timeout: 20_000 }).toBe(true);
      const channel = await exchange();
      channelId = channel.id;
      expect(channel.messages.some((message: { from?: { botId?: string }; text?: string }) =>
        message.from?.botId === asker.id && message.text === "Ink, can you take the deploy?")).toBe(true);
      expect(channel.unread).toBeFalsy();
      expect((await botState(peer.id))?.unread).toBeFalsy();

      expect((await api("PATCH", `/api/bots/${peer.id}`, { name: "Ink observed" })).status).toBe(200);
      await stream.until(
        (candidate) => candidate.kind === "bot" && candidate.bot?.id === peer.id && candidate.bot?.name === "Ink observed",
      );
      expect(stream.frames.filter((candidate) => candidate.kind === "notify" &&
        (candidate.notification?.botId === peer.id || candidate.notification?.threadId === channel.threadId))).toEqual([]);
    } finally {
      stream.close();
      await cleanup([channelId], [asker.id, peer.id]);
    }
  }, 45_000);

  it("still buzzes when the other dog's turn stops to ask the person a question", async () => {
    const asker = await createBot("Quill", "quick");
    const peer = await createBot("Sage", "curious", "fake-model");
    let channelId: string | undefined;
    const stream = await openSse(`${base}/api/events`);
    const asking = api(
      "POST",
      "/api/internal/coordinate-bots",
      { botIds: [peer.id], message: "Sage, which colour?" },
      await capability(asker.id, asker.threadId),
    );
    try {
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === peer.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({
        kind: "question",
        botId: peer.id,
        threadId: peer.threadId,
        title: "Sage has a question",
      });
      const card = (await botState(peer.id))?.messages.findLast(
        (message: { kind: string; card?: { title?: string } }) => message.kind === "options" && Boolean(message.card),
      );
      expect(card?.card).toMatchObject({ title: "Your dog has a question", subtitle: "Which color?" });

      const current = await state(0);
      channelId = current.groups.find(
        (group: { dm?: boolean; memberIds: string[] }) =>
          group.dm === true && group.memberIds.includes(asker.id) && group.memberIds.includes(peer.id),
      )?.id;
    } finally {
      stream.close();
      await api("POST", `/api/bots/${peer.id}/interrupt`, {}).catch(() => undefined);
      await asking.catch(() => undefined);
      await cleanup([channelId], [asker.id, peer.id]);
    }
  }, 45_000);
});
