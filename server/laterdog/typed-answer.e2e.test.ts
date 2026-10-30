import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { typedReplyAnswer } from "./typed-answer.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === "win32")("typing a reply while a dog waits on its question", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let dump: string;
  let codexDump: string;
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

  const dogAskingAQuestion = async (asks: "form" | "choices" = "form") => {
    rmSync(finishGate, { force: true });
    rmSync(dump, { force: true });
    const created = await api("POST", "/api/bots", {
      name: "Asker",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Ask me what to work on first." })).status).toBe(202);
    await waitFor(() => busy(bot.id), "the dog to start working");
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
    socket.write(JSON.stringify(asks === "choices"
      ? { t: "ask", kind: "question", id: requestId, tool: "ask_user", input: { question: "What should I help with first?", choices: ["Code and GitHub", "Research and writing"] } }
      : {
        t: "ask",
        kind: "question",
        id: requestId,
        tool: "AskUserQuestion",
        input: { questions: [{ question: "What should I help with first?", options: [{ label: "Code and GitHub" }, { label: "Research and writing" }] }] },
      }) + "\n");
    await waitFor(() => card(bot.threadId, requestId), "the question card");
    return { bot, requestId, replies };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(FAKE_CODEX, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-typed-answer-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    dump = join(home, "fake-claude-dump.json");
    codexDump = join(home, "fake-codex-dump.json");
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
          codex: {
            driver: "codex",
            displayName: "Fixture Codex",
            environment: { FAKE_CODEX_MODE: "multi-question", FAKE_CODEX_ASK_HOLD: "1", FAKE_CODEX_DUMP: codexDump },
            config: { cli: FAKE_CODEX },
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
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("hands the typed words to the dog as its answer and tucks the card away", async () => {
    const { bot, requestId, replies } = await dogAskingAQuestion();
    const typed = "Actually, help me plan a weekend in Lisbon.";
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: typed, sendId: "typed-reply-0000001" });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, threadId: bot.threadId, message: { role: "user", text: typed } });
    expect(sent.body.steered).toBeUndefined();
    expect(sent.body.queued).toBeUndefined();

    const reply = await waitFor(async () => replies.find((entry) => entry.id === requestId), "the dog to get the typed answer");
    expect(reply).toMatchObject({ t: "answer", behavior: "answer", message: typedReplyAnswer(typed), source: "user" });
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true, answeredBy: { kind: "loopback" } });
    const bubble = (await messages(bot.threadId)).find((m) => m.sendId === "typed-reply-0000001");
    expect(bubble).toMatchObject({ role: "user", kind: "text", text: typed });
    expect(bubble.steered).toBeUndefined();

    const again = await api("POST", `/api/bots/${bot.id}/messages`, { text: typed, sendId: "typed-reply-0000001" });
    expect(again.status).toBe(202);
    expect(again.body.message.id).toBe(bubble.id);
    expect((await messages(bot.threadId)).filter((m) => m.sendId === "typed-reply-0000001")).toHaveLength(1);

    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await busy(bot.id)), "the turn to settle");
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true });
  }, 60_000);

  it("answers a question the dog asked with plain choices the same way, instead of steering past it", async () => {
    const { bot, requestId, replies } = await dogAskingAQuestion("choices");
    expect(await card(bot.threadId, requestId)).toMatchObject({ requestType: "question", options: ["Code and GitHub", "Research and writing"] });
    expect((await card(bot.threadId, requestId)).questionRequest).toBeUndefined();
    const typed = "I had a resize tool project.";
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: typed });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, threadId: bot.threadId, message: { role: "user", text: typed } });
    expect(sent.body.steered).toBeUndefined();

    const reply = await waitFor(async () => replies.find((entry) => entry.id === requestId), "the dog to get the typed answer");
    expect(reply).toMatchObject({ t: "answer", behavior: "answer", message: typedReplyAnswer(typed), source: "user" });
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer", dismissed: true });

    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await busy(bot.id)), "the turn to settle");
  }, 60_000);

  it("leaves a question that was already answered alone and steers the next message as before", async () => {
    const { bot, requestId, replies } = await dogAskingAQuestion();
    const picked = await api("POST", `/api/threads/${bot.threadId}/respond`, { requestId, behavior: "answer", message: "Code and GitHub" });
    expect(picked).toMatchObject({ status: 200, body: { ok: true } });
    await waitFor(async () => replies.find((entry) => entry.id === requestId), "the picked answer");

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "And keep it short.", sendId: "after-pick-0000001" });
    expect(sent.status).toBe(202);
    expect(replies.filter((entry) => entry.id === requestId)).toHaveLength(1);
    expect(await card(bot.threadId, requestId)).toMatchObject({ answered: "answer" });
    expect((await card(bot.threadId, requestId)).dismissed).not.toBe(true);

    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await busy(bot.id)), "the turn to settle");
  }, 60_000);

  it("lets a message the person chose to queue wait for the turn instead of answering", async () => {
    const { bot, requestId, replies } = await dogAskingAQuestion();
    const later = "Then plan my week.";
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: later, deliver: "queue" });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ queued: true, queueId: expect.any(String) });
    expect((await card(bot.threadId, requestId)).answered).toBeUndefined();

    writeFileSync(finishGate, "finish");
    await waitFor(async () => (await messages(bot.threadId)).some((m) => m.role === "user" && m.text === later), "the queued message to be sent");
    await waitFor(async () => !(await busy(bot.id)), "the turns to settle");
    expect(replies.filter((entry) => entry.id === requestId && entry.source === "user")).toEqual([]);
  }, 60_000);

  it("gets a ChatGPT dog's open questions answered too, under the first one", async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    const model = instances.find((instance: any) => instance.instanceId === "codex").models.default;
    const created = await api("POST", "/api/bots", { name: "Planner", modelSelection: { instanceId: "codex", model } });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "Ask me what to ship." })).status).toBe(202);
    const asked = await waitFor(async () => (await messages(bot.threadId)).find((m) => m.card?.questionRequest)?.card, "the codex questions");
    expect(asked.questionRequest.questions.map((question: any) => question.question)).toEqual(["Ship today?", "Who reviews?"]);

    const typed = "Hold off, Lin is out this week.";
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: typed });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ ok: true, threadId: bot.threadId, message: { role: "user", text: typed } });
    expect(sent.body.steered).toBeUndefined();
    expect(sent.body.queued).toBeUndefined();
    const decision = await waitFor(async () => {
      try {
        return (JSON.parse(readFileSync(codexDump, "utf8")) as { decision: unknown }).decision;
      } catch {
        return null;
      }
    }, "codex to get the typed answer");
    expect(decision).toEqual({ answers: { "q-ship": { answers: [typedReplyAnswer(typed)] } } });
    expect(await card(bot.threadId, asked.requestId)).toMatchObject({ answered: "answer", dismissed: true });

    await api("POST", `/api/bots/${bot.id}/interrupt`);
    await waitFor(async () => !(await busy(bot.id)), "the codex turn to settle");
  }, 60_000);
});
