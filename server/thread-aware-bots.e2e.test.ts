import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const TEST_CAPABILITY_KEY = "thread-aware-bots-fixture-capability";

let child: ChildProcess;
let home = "";
let gates = "";
let base = "";
let stderr = "";

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

const release = (threadId: string) => writeFileSync(join(gates, `${threadId}.gate`), "finish");
const dumpOf = (threadId: string): { systemPrompt?: string; mcpConfig?: any } | undefined => {
  try {
    return JSON.parse(readFileSync(join(gates, `${threadId}.json`), "utf8"));
  } catch {
    return undefined;
  }
};
const promptsOf = (threadId: string): any[] => {
  try {
    return readFileSync(join(gates, `${threadId}.prompts.jsonl`), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
};
const liveToken = async (threadId: string): Promise<Record<string, string>> => {
  await expect.poll(() => dumpOf(threadId)?.mcpConfig?.mcpServers?.agents?.env?.LATERDOG_COMMS_TOKEN, { timeout: 15_000 }).toBeTruthy();
  return { authorization: `Bearer ${dumpOf(threadId)!.mcpConfig.mcpServers.agents.env.LATERDOG_COMMS_TOKEN}` };
};
const heldTurn = async (bot: { id: string; threadId: string }, text: string): Promise<Record<string, string>> => {
  await expect.poll(async () => Boolean((await botState(bot.id))?.busy), { timeout: 15_000 }).toBe(false);
  rmSync(join(gates, `${bot.threadId}.gate`), { force: true });
  rmSync(join(gates, `${bot.threadId}.json`), { force: true });
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  expect(sent.status).toBe(202);
  expect(sent.body.queued).toBeUndefined();
  return liveToken(bot.threadId);
};
const bots = async () => (await api("GET", "/api/bots?messages=0")).body.bots as any[];
const botState = async (botId: string) => (await bots()).find((bot) => bot.id === botId);
const taskOf = async (botId: string, threadId: string) => (await botState(botId))?.tasks.find((task: any) => task.threadId === threadId);
const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).body.messages as any[];
const handoffs = (): any[] => JSON.parse(readFileSync(join(home, ".laterdog", "room-handoffs.json"), "utf8"));
const coordinated = async (headers: Record<string, string>, botId: string, message: string) => {
  const response = await api("POST", "/api/internal/coordinate-bots", { botIds: [botId], message }, headers);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.receipts).toHaveLength(1);
  return handoffs().find(node => node.id === response.body.receipts[0].requestId);
};

const createBot = async (name: string, instanceId: string, model = "claude-sonnet-5") => {
  const created = (await api("POST", "/api/bots", {})).body.bot;
  const patched = await api("PATCH", `/api/bots/${created.id}`, { name, notifications: true, modelSelection: { instanceId, model } });
  expect(patched.status).toBe(200);
  return patched.body.bot;
};

const cleanup = async (botIds: string[]) => {
  for (const botId of botIds) await api("POST", `/api/bots/${botId}/interrupt`, {}).catch(() => undefined);
  for (const botId of botIds) await api("DELETE", `/api/bots/${botId}`).catch(() => undefined);
};

beforeAll(async () => {
  chmodSync(FAKE_CLAUDE, 0o755);
  chmodSync(FAKE_ACP, 0o755);
  home = mkdtempSync(join(tmpdir(), "laterdog-thread-aware-"));
  gates = join(home, "gates");
  const data = join(home, ".laterdog");
  mkdirSync(data, { recursive: true });
  mkdirSync(gates, { recursive: true });
  const gated = join(home, "gated-claude.mjs");
  writeFileSync(gated, [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { PassThrough } from "node:stream";',
    'const at = process.argv.indexOf("--mcp-config");',
    "let thread = null;",
    "if (at >= 0) {",
    "  try {",
    '    const servers = JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers ?? {};',
    "    for (const server of Object.values(servers)) thread ??= server?.env?.LATERDOG_THREAD_ID ?? null;",
    "  } catch {}",
    "}",
    "const relay = new PassThrough();",
    "const real = process.stdin;",
    'Object.defineProperty(process, "stdin", { value: relay, configurable: true });',
    "let decided = false;",
    'let held = "";',
    'real.on("data", (chunk) => {',
    "  if (decided) { relay.write(chunk); return; }",
    "  held += chunk;",
    '  const nl = held.indexOf("\\n");',
    "  if (nl === -1) return;",
    "  const marker = /\\[\\[gate:([\\w-]+)\\]\\]/.exec(held.slice(0, nl));",
    '  const key = marker?.[1] ?? thread ?? "peer";',
    `  process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(${JSON.stringify(gates)}, key + ".gate");`,
    `  process.env.FAKE_CLAUDE_DUMP = join(${JSON.stringify(gates)}, key + ".json");`,
    `  process.env.FAKE_CLAUDE_PROMPTS = join(${JSON.stringify(gates)}, key + ".prompts.jsonl");`,
    "  decided = true;",
    "  relay.write(held);",
    '  held = "";',
    "});",
    'real.on("end", () => relay.end());',
    'process.env.FAKE_CLAUDE_MODE = "slow";',
    `await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});`,
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(data, "config.json"), JSON.stringify({
    threads: { maxConcurrentPerBot: 2 },
    instances: {
      gated: {
        driver: "claudeAgent",
        displayName: "Gated fixture",
        config: { cli: gated },
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

describe("send_to_bot to a teammate", () => {
  it("sends a repeat request to the thread it already has open with that teammate, and opens nothing on itself", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    const ops = await createBot("Ria", "gated");
    try {
      const token = await heldTurn(pm, "Send these to QA and Ops.");
      const first = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "Check A", message: "First check.", oneWay: true }, token);
      expect(first.status).toBe(201);
      expect(first.body.reused).toBeUndefined();
      const again = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "Check B", message: "Second check.", oneWay: true }, token);
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ reused: true, threadId: first.body.threadId, title: "Check A" });
      expect(again.body.note).toContain("Added to your open thread #Check A with Quinn");
      expect((await botState(qa.id)).tasks).toHaveLength(2);
      const other = await api("POST", "/api/internal/threads", { toBotId: ops.id, title: "Check C", message: "Third check.", oneWay: true }, token);
      expect(other.status).toBe(201);
      expect(other.body.threadId).not.toBe(first.body.threadId);
      expect((await botState(ops.id)).tasks).toHaveLength(2);
      const chips = (await messages(pm.threadId)).filter((message) => message.threadRef).map((message) => message.tool.name);
      expect(chips).toEqual(["Opened thread #Check A on Quinn", "Added to thread #Check A on Quinn", "Opened thread #Check C on Ria"]);
      const self = await api("POST", "/api/internal/threads", { toBotId: pm.id, title: "Own job", message: "go", oneWay: true }, token);
      expect(self.status).toBe(409);
      expect(self.body.error).toContain("cross-bot only");
      const twoWay = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "Check D", message: "go" }, token);
      expect(twoWay.status).toBe(400);
      const untitled = await api("POST", "/api/internal/threads", { toBotId: qa.id, title: "two\nlines", message: "go", oneWay: true }, token);
      expect(untitled.status).toBe(400);
      expect(untitled.body.error).toContain("fit on one line");
      expect((await botState(pm.id)).tasks).toHaveLength(1);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id))?.busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([pm.id, qa.id, ops.id]);
    }
  }, 60_000);

});

describe("coordinate_bots on a teammate", () => {
  it.each([1, 2])("runs three requests in the teammate's one conversation, one at a time within capacity %i, and returns all results", async (capacity) => {
    expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: capacity } })).status).toBe(200);
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    const stream = await openSse(`${base}/api/events`);
    try {
      const token = await heldTurn(pm, "Hand the pull requests to QA.");
      const gate = (index: number) => `pr-${capacity}-${index}`;
      const opened: any[] = [];
      for (let index = 1; index <= 3; index++) {
        opened.push(await coordinated(token, qa.id, `Test pull request ${index}. [[gate:${gate(index)}]]`));
      }
      const before = await botState(qa.id);
      expect(before.threadId).toBe(qa.threadId);
      const thread = qa.threadId;
      expect(opened.map((node) => node.threadId)).toEqual([thread, thread, thread]);
      expect(before.tasks).toHaveLength(1);
      expect(dumpOf(gate(2))).toBeUndefined();
      expect(dumpOf(gate(3))).toBeUndefined();
      const chips = (await messages(pm.threadId)).filter((message) => message.threadRef);
      expect(chips.map((chip) => [chip.tool.name, chip.threadRef.botId, chip.threadRef.threadId])).toEqual(
        opened.map(() => ["Sent to Quinn", qa.id, thread]),
      );
      release(pm.threadId);
      for (let index = 0; index < opened.length; index++) {
        const node = opened[index];
        const live = await liveToken(gate(index + 1));
        await expect.poll(() => handoffs().filter(n => n.botId === qa.id && n.status === "running").map(n => n.id), { timeout: 15_000 }).toEqual([node.id]);
        expect(handoffs().filter(n => n.botId === qa.id && n.status === "queued")).toHaveLength(opened.length - index - 1);
        const request = (await messages(thread)).find((message) => message.roomRequest?.id === node.id && message.roomRequest.phase === "request");
        expect(request).toMatchObject({ from: { botId: pm.id } });
        expect(request.text).toContain(`Test pull request ${index + 1}.`);
        expect(dumpOf(gate(index + 1))?.systemPrompt).toContain("coordinate_bots");
        expect((await api("POST", "/api/internal/threads", { title: "Recursive work", message: "go" }, live)).status).toBe(400);
        release(gate(index + 1));
        await expect.poll(() => handoffs().find(n => n.id === node.id)?.status, { timeout: 15_000 }).toBe("completed");
      }
      await expect.poll(async () => (await messages(pm.threadId)).filter(
        (message) => message.from?.botId === qa.id && message.roomRequest?.phase === "result",
      ).length, { timeout: 20_000 }).toBe(3);
      await expect.poll(async () => {
        const state = await botState(pm.id);
        return state?.busy === false && state.waitingForTeammates !== true;
      }, { timeout: 15_000 }).toBe(true);
      expect(promptsOf(gate(1)).at(-1)?.message.content).toContain("Your downstream room requests have settled");
      expect(stream.frames.filter((frame) => frame.kind === "notify" && frame.notification?.botId === qa.id)).toEqual([]);
      expect((await botState(qa.id)).threadId).toBe(qa.threadId);
      expect((await botState(qa.id)).tasks).toHaveLength(1);
    } finally {
      stream.close();
      await cleanup([pm.id, qa.id]);
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 90_000);

  it("rejects legacy peer starts, inaccessible peers, and oversized batches, and does not duplicate a retried request", async () => {
    const pm = await createBot("Pam", "gated");
    const near = await createBot("Near", "gated");
    const far = await createBot("Far", "gated");
    const other = await createBot("Other", "gated");
    try {
      expect((await api("PATCH", `/api/bots/${other.id}`, { section: "Elsewhere" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${near.id}`, { section: "Allowed across packs" })).status).toBe(200);
      expect((await api("PATCH", `/api/bots/${pm.id}`, { peers: [near.id] })).status).toBe(200);
      const token = await heldTurn(pm, "Coordinate only with my allowed teammate.");
      expect((await api("POST", "/api/internal/threads", { toBotId: near.id, title: "Job", message: "go" }, token)).status).toBe(400);
      const send = (botIds: string[]) => api("POST", "/api/internal/coordinate-bots", { botIds, message: "Check it." }, token);
      const outside = await send([other.id]);
      expect(outside.status).toBe(403);
      expect(outside.body.error).toContain("allowed peer");
      const unlisted = await send([far.id]);
      expect(unlisted.status).toBe(403);
      expect(unlisted.body.error).toContain("allowed peer");
      expect((await send([near.id, far.id])).status).toBe(403);
      expect((await send([near.id, far.id, other.id, pm.id, "fifth"])).status).toBe(400);
      for (const bot of [other, far, near]) expect((await botState(bot.id)).tasks).toHaveLength(1);
      const first = await coordinated(token, near.id, "Check it.");
      expect(first.threadId).toBe(near.threadId);
      const retry = await send([near.id]);
      expect(retry.body.receipts).toEqual([expect.objectContaining({ requestId: first.id, threadId: near.threadId, detail: expect.stringContaining("already sent") })]);
      expect((await botState(near.id)).tasks).toHaveLength(1);
      expect((await messages(pm.threadId)).filter(message => message.threadRef?.threadId === first.threadId)).toHaveLength(1);
    } finally {
      await cleanup([pm.id, near.id, far.id, other.id]);
    }
  }, 60_000);

  it("waits for the person's approval card and creates no recipient work when denied", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      const originalConversation = await messages(qa.threadId);
      expect((await api("PATCH", `/api/bots/${pm.id}`, { approvePeerComms: true })).status).toBe(200);
      const token = await heldTurn(pm, "Hand it to QA.");
      const pending = api("POST", "/api/internal/coordinate-bots", { botIds: [qa.id], message: "Test it." }, token);
      await expect.poll(async () => (await messages(pm.threadId)).some((message) => message.card?.tool === "delegate_bot"), { timeout: 15_000 }).toBe(true);
      const card = (await messages(pm.threadId)).find((message) => message.card?.tool === "delegate_bot");
      expect((await botState(qa.id)).tasks).toHaveLength(1);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
      expect((await api("POST", `/api/bots/${pm.id}/respond`, { threadId: pm.threadId, requestId: card.card.requestId, behavior: "deny" })).status).toBe(200);
      expect(await pending).toMatchObject({ status: 403, body: { error: "The person said no; no work sent." } });
      expect((await botState(qa.id)).tasks).toHaveLength(1);
      expect(await messages(qa.threadId)).toEqual(originalConversation);
      release(pm.threadId);
      await expect.poll(async () => (await botState(pm.id)).busy, { timeout: 15_000 }).toBe(false);
    } finally {
      await cleanup([pm.id, qa.id]);
    }
  }, 60_000);

  it("reports a deleted queued destination without moving the work to the recipient's next conversation", async () => {
    const pm = await createBot("Pam", "gated");
    const qa = await createBot("Quinn", "gated");
    try {
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } })).status).toBe(200);
      const hold = (await api("POST", `/api/bots/${qa.id}/tasks`, { title: "Hold the slot" })).body.task;
      expect((await api("POST", `/api/bots/${qa.id}/tasks/${qa.threadId}`, {})).status).toBe(200);
      rmSync(join(gates, `${hold.threadId}.gate`), { force: true });
      rmSync(join(gates, `${hold.threadId}.json`), { force: true });
      expect((await api("POST", `/api/bots/${qa.id}/messages`, { text: "Hold the slot.", threadId: hold.threadId })).status).toBe(202);
      await expect.poll(async () => (await taskOf(qa.id, hold.threadId))?.busy, { timeout: 15_000 }).toBe(true);
      const token = await heldTurn(pm, "Hand it to QA.");
      const opened = await coordinated(token, qa.id, "Test it.");
      expect(opened.threadId).toBe(qa.threadId);
      expect((await api("DELETE", `/api/bots/${qa.id}/tasks/${opened.threadId}`)).status).toBe(200);
      release(pm.threadId);
      await expect.poll(() => handoffs().find(node => node.id === opened.id)?.status, { timeout: 15_000 }).toBe("cancelled");
      await expect.poll(async () => {
        const state = await botState(pm.id);
        return state?.busy === false && state.waitingForTeammates !== true;
      }, { timeout: 15_000 }).toBe(true);
      expect((await messages(pm.threadId)).some(message => message.roomRequest?.id === opened.id && message.roomRequest.phase === "result" && message.tool?.ok === false)).toBe(true);
      release(hold.threadId);
      await expect.poll(async () => (await taskOf(qa.id, hold.threadId))?.busy, { timeout: 15_000 }).toBe(false);
      expect((await messages(hold.threadId)).some((message) => message.roomRequest?.id === opened.id)).toBe(false);
    } finally {
      await cleanup([pm.id, qa.id]);
      expect((await api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 2 } })).status).toBe(200);
    }
  }, 60_000);

  it("still buzzes when a coordinated thread asks the person a question, deep-linked to that thread", async () => {
    const pm = await createBot("Pam", "gated");
    const sage = await createBot("Sage", "curious", "fake-model");
    const stream = await openSse(`${base}/api/events`);
    try {
      const token = await heldTurn(pm, "Ask Sage.");
      const opened = await coordinated(token, sage.id, "Which colour?");
      release(pm.threadId);
      const frame = await stream.until(
        (candidate) => candidate.kind === "notify" && candidate.notification?.botId === sage.id,
        20_000,
      );
      expect(frame.notification).toMatchObject({ kind: "question", botId: sage.id, threadId: opened.threadId });
      expect(frame.notification.threadId).toBe(sage.threadId);
      const card = (await messages(opened.threadId)).findLast((message) => message.kind === "options" && Boolean(message.card));
      expect(card?.card).toMatchObject({ title: "Your dog has a question" });
    } finally {
      stream.close();
      await cleanup([pm.id, sage.id]);
    }
  }, 60_000);
});
