import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === "win32")("the × on a dog's question", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let dump: string;
  let finishGate: string;
  const sockets: Socket[] = [];

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async <T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 15_000): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const busy = async (botId: string) => (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy === true;
  const messages = async (threadId: string): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
  const card = async (threadId: string, requestId: string) => (await messages(threadId)).find((m) => m.card?.requestId === requestId)?.card;
  const working = async (roomId: string) => (await api("GET", "/api/bots?messages=0")).body.groups.find((g: any) => g.id === roomId)?.working === true;

  const newAsker = async () => {
    rmSync(finishGate, { force: true });
    rmSync(dump, { force: true });
    const created = await api("POST", "/api/bots", {
      name: "Asker",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    return created.body.bot as { id: string; threadId: string };
  };

  const dogAskingAQuestion = async () => {
    const bot = await newAsker();
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Ask me what to work on first." })).status).toBe(202);
    return { bot, ...(await askOn(bot.threadId, () => busy(bot.id))) };
  };

  const roomAskingAQuestion = async () => {
    const bot = await newAsker();
    const created = await api("POST", "/api/groups", {
      name: "Ask room",
      memberIds: [bot.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
    });
    expect(created.status).toBe(201);
    const room = created.body.group as { id: string; threadId: string };
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "Ask me what to work on first." })).status).toBe(202);
    return { room, ...(await askOn(room.threadId, () => working(room.id))) };
  };

  const askOn = async (threadId: string, started: () => Promise<boolean>) => {
    await waitFor(started, "the dog to start working");
    const launch = await waitFor(async () => {
      if (!existsSync(dump)) return null;
      try {
        return JSON.parse(readFileSync(dump, "utf8")) as { mcpConfig: { mcpServers: { dog: { args: string[] } } } };
      } catch {
        return null;
      }
    }, "the fake CLI's launch files");
    const socket = connect(launch.mcpConfig.mcpServers.dog.args[1]!);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let buffer = "";
    const replies: Record<string, unknown>[] = [];
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        replies.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const requestId = randomUUID();
    socket.write(JSON.stringify({
      t: "ask",
      kind: "question",
      id: requestId,
      tool: "AskUserQuestion",
      input: { questions: [{ question: "What should I help with first?", options: [{ label: "Code and GitHub" }, { label: "Research and writing" }] }] },
    }) + "\n");
    await waitFor(() => card(threadId, requestId), "the question card");
    return { requestId, replies };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-close-question-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    dump = join(home, "fake-claude-dump.json");
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claude: {
            driver: "claudeAgent",
            displayName: "Fixture Claude",
            environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_DUMP: dump, FAKE_CLAUDE_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        LATERDOG_SERVER_PORT: String(PORT),
        LATERDOG_WEBHOOK_PORT: String(PORT + 1),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    while (!(await fetch(`${BASE}/api/health`).then((res) => res.ok, () => false))) {
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 30_000);

  afterAll(async () => {
    if (finishGate) writeFileSync(finishGate, "finish");
    for (const socket of sockets) socket.destroy();
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("ends the dog's wait with the close note and hides the card", async () => {
    const { bot, requestId, replies } = await dogAskingAQuestion();
    const closed = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId,
      behavior: "answer",
      message: QUESTION_DISMISS_MESSAGE,
    });
    expect(closed).toMatchObject({ status: 200, body: { ok: true, dismissed: true, outcome: "answered" } });
    const reply = await waitFor(async () => replies.find((entry) => entry.id === requestId), "the dog to get the close note");
    expect(reply).toMatchObject({ t: "answer", behavior: "answer", message: QUESTION_DISMISS_MESSAGE, source: "user" });
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true });

    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await busy(bot.id)), "the turn to settle");
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true });
  }, 60_000);

  it("hides a question left open after its turn ended, without starting a new turn", async () => {
    const { bot, requestId, replies } = await dogAskingAQuestion();
    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await busy(bot.id)), "the turn to settle");
    const ending = await waitFor(async () => replies.find((entry) => entry.id === requestId), "the broker to end the ask");
    expect(ending).toMatchObject({ behavior: "answer", source: "system" });
    const left = await card(bot.threadId, requestId);
    expect(left.answered).toBeUndefined();
    expect(left.dismissed).toBeUndefined();
    const before = (await messages(bot.threadId)).length;

    rmSync(finishGate, { force: true });
    const closed = await api("POST", `/api/bots/${bot.id}/respond`, { requestId, behavior: "answer", dismiss: true });
    expect(closed).toMatchObject({ status: 200, body: { ok: true, dismissed: true, outcome: "unavailable" } });
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(await busy(bot.id)).toBe(false);
    expect(await messages(bot.threadId)).toHaveLength(before);

    const again = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "answer", message: QUESTION_DISMISS_MESSAGE });
    expect(again).toMatchObject({ status: 200, body: { ok: true, dismissed: true } });
    expect(again.body.outcome).toBeUndefined();
  }, 60_000);

  it("hides a room question left open after its turn ended, without starting a new turn", async () => {
    const { room, requestId } = await roomAskingAQuestion();
    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await working(room.id)), "the room's turn to settle");
    const left = await card(room.threadId, requestId);
    expect(left.answered).toBeUndefined();
    expect(left.dismissed).toBeUndefined();
    const before = (await messages(room.threadId)).length;

    rmSync(finishGate, { force: true });
    const closed = await api("POST", `/api/threads/${room.threadId}/respond`, { requestId, behavior: "answer", dismiss: true });
    expect(closed).toMatchObject({ status: 200, body: { ok: true, dismissed: true, outcome: "unavailable" } });
    expect(await card(room.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(await working(room.id)).toBe(false);
    expect(await messages(room.threadId)).toHaveLength(before);
  }, 60_000);
});
