import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leasePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = await leasePortBlock([0, 1]);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT_MS = 2_000;

const deploy = {
  question: "Should I point it at the live address?",
  options: [{ label: "Leave it" }, { label: "Yes, update it (Recommended)" }],
};
const branch = {
  question: "Which branch should I use?",
  options: [{ label: "main" }, { label: "dev" }],
};

describe.skipIf(process.platform === "win32")("a question nobody answers in time", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let dump: string;
  let finishGate: string;
  const sockets: Socket[] = [];

  const api = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const waitFor = async <T>(
    read: () => Promise<T | null | undefined | false>,
    what: string,
    ms = 15_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value) return value;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const busy = async (botId: string) =>
    (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === botId)?.busy ===
    true;
  const messages = async (threadId: string): Promise<any[]> =>
    (await api("GET", `/api/threads/${threadId}/messages`)).body.messages;
  const card = async (threadId: string, requestId: string) =>
    (await messages(threadId)).find((m) => m.card?.requestId === requestId)?.card;

  const dogAsks = async (ask: {
    kind?: "question";
    tool: string;
    input: Record<string, unknown>;
  }) => {
    rmSync(finishGate, { force: true });
    rmSync(dump, { force: true });
    const created = await api("POST", "/api/bots", {
      name: "Asker",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot as { id: string; threadId: string };
    expect(
      (
        await api("POST", `/api/bots/${bot.id}/messages`, {
          text: "Fix the address, then tell me.",
        })
      ).status,
    ).toBe(202);
    await waitFor(() => busy(bot.id), "the dog to start working");
    const launch = await waitFor(async () => {
      if (!existsSync(dump)) return null;
      try {
        return JSON.parse(readFileSync(dump, "utf8")) as {
          mcpConfig: { mcpServers: { dog: { args: string[] } } };
        };
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
    const replies: Record<string, any>[] = [];
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        replies.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const requestId = randomUUID();
    const asked = Date.now();
    socket.write(JSON.stringify({ t: "ask", id: requestId, ...ask }) + "\n");
    await waitFor(() => card(bot.threadId, requestId), "the card");
    return { bot, requestId, replies, asked };
  };
  const finish = async (botId: string) => {
    writeFileSync(finishGate, "finish");
    await waitFor(async () => !(await busy(botId)), "the turn to settle");
  };

  const startServer = async () => {
    stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        HOME: home,
        USERPROFILE: home,
        LATERDOG_SERVER_PORT: String(PORT),
        LATERDOG_WEBHOOK_PORT: String(PORT + 1),
        LATERDOG_QUESTION_AUTOPICK_MS: String(WAIT_MS),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));
    const deadline = Date.now() + 20_000;
    while (
      !(await fetch(`${BASE}/api/health`).then(
        (res) => res.ok,
        () => false,
      ))
    ) {
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null)
        throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const stopServer = async (signal: NodeJS.Signals) => {
    const running = child;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => running.once("close", () => resolve()));
    running.kill(signal);
    const hard = setTimeout(() => running.kill("SIGKILL"), 5_000);
    await closed;
    clearTimeout(hard);
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-question-autopick-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    dump = join(home, "fake-claude-dump.json");
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        profile: { name: "Robin" },
        features: { autoReview: false },
        signIn: { admins: ["robin@example.com"], members: ["teammate@example.com"] },
        instances: {
          claude: {
            driver: "claudeAgent",
            displayName: "Fixture Claude",
            environment: {
              FAKE_CLAUDE_MODE: "hang",
              FAKE_CLAUDE_DUMP: dump,
              FAKE_CLAUDE_FINISH_GATE: finishGate,
            },
            config: { cli: FAKE_CLAUDE },
          },
        },
      }),
    );
    await startServer();
  }, 30_000);

  afterAll(async () => {
    if (finishGate) writeFileSync(finishGate, "finish");
    for (const socket of sockets) socket.destroy();
    await stopServer("SIGTERM");
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("shows when it will pick, then picks the recommended option, tells the dog, and lets the next message through as a message", async () => {
    const { bot, requestId, replies, asked } = await dogAsks({
      kind: "question",
      tool: "AskUserQuestion",
      input: { questions: [deploy] },
    });
    const open = await card(bot.threadId, requestId);
    expect(open.answered).toBeUndefined();
    expect(open.autoAnswerAt).toBeGreaterThanOrEqual(asked + WAIT_MS - 50);
    expect(open.autoAnswerAt).toBeLessThanOrEqual(Date.now() + WAIT_MS);

    const reply = await waitFor(
      async () => replies.find((entry) => entry.id === requestId),
      "the picked answer",
    );
    expect(reply).toMatchObject({
      t: "answer",
      behavior: "answer",
      message: `Q: ${deploy.question}\nA: No answer after 2 s; auto-picked the recommended option: Yes, update it (Recommended)`,
    });
    expect(Date.now() - asked).toBeGreaterThanOrEqual(WAIT_MS - 50);
    const settled = await waitFor(async () => {
      const latest = await card(bot.threadId, requestId);
      return latest?.autoPicked ? latest : null;
    }, "the card to show the pick");
    expect(settled).toMatchObject({
      answered: "answer",
      autoPicked: true,
      answeredText: `Q: ${deploy.question}\nA: Yes, update it (Recommended)`,
    });
    expect(settled.dismissed).not.toBe(true);

    const sent = await api("POST", `/api/bots/${bot.id}/messages`, {
      text: "Actually, leave it as it is.",
      sendId: "after-autopick-001",
    });
    expect(sent.status).toBe(202);
    expect(replies.filter((entry) => entry.id === requestId)).toHaveLength(1);
    expect(
      (await messages(bot.threadId)).find((m) => m.sendId === "after-autopick-001"),
    ).toMatchObject({ role: "user", text: "Actually, leave it as it is." });
    await finish(bot.id);
  }, 60_000);

  it("tells the dog to keep going on its own judgment when the question had nothing to pick", async () => {
    const { bot, requestId, replies } = await dogAsks({
      kind: "question",
      tool: "ask_user",
      input: { question: "Anything I should know first?" },
    });
    const reply = await waitFor(
      async () => replies.find((entry) => entry.id === requestId),
      "the answer for the dog",
    );
    expect(reply).toMatchObject({
      behavior: "answer",
      message:
        "Robin didn't answer in time. Use your best judgment and keep going. They can correct you later.",
    });
    await waitFor(
      async () => (await card(bot.threadId, requestId))?.autoPicked,
      "the card to settle",
    );
    await finish(bot.id);
  }, 60_000);

  it("keeps what the person already picked and fills in only the rest", async () => {
    const { bot, requestId, replies } = await dogAsks({
      kind: "question",
      tool: "AskUserQuestion",
      input: { questions: [branch, deploy] },
    });
    const kept = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId,
      behavior: "picks",
      picks: [["dev"], []],
    });
    expect(kept).toMatchObject({ status: 200, body: { ok: true } });
    expect(replies.filter((entry) => entry.id === requestId)).toEqual([]);

    const reply = await waitFor(
      async () => replies.find((entry) => entry.id === requestId),
      "the answers",
    );
    expect(reply.message).toBe(
      `Q: ${branch.question}\nA: dev\n\nQ: ${deploy.question}\nA: No answer after 2 s; auto-picked the recommended option: Yes, update it (Recommended)`,
    );
    const settled = await waitFor(async () => {
      const latest = await card(bot.threadId, requestId);
      return latest?.autoPicked ? latest : null;
    }, "the card to settle");
    expect(settled.answeredText).toBe(
      `Q: ${branch.question}\nA: dev\n\nQ: ${deploy.question}\nA: Yes, update it (Recommended)`,
    );
    await finish(bot.id);
  }, 60_000);

  it("leaves a question the person answered in time alone", async () => {
    const { bot, requestId, replies } = await dogAsks({
      kind: "question",
      tool: "AskUserQuestion",
      input: { questions: [branch] },
    });
    const picked = await api("POST", `/api/threads/${bot.threadId}/respond`, {
      requestId,
      behavior: "answer",
      message: `Q: ${branch.question}\nA: dev`,
    });
    expect(picked).toMatchObject({ status: 200, body: { ok: true } });
    await new Promise((r) => setTimeout(r, WAIT_MS + 1_000));
    expect(replies.filter((entry) => entry.id === requestId)).toHaveLength(1);
    expect(replies.find((entry) => entry.id === requestId)?.message).toBe(
      `Q: ${branch.question}\nA: dev`,
    );
    const settled = await card(bot.threadId, requestId);
    expect(settled).toMatchObject({ answered: "answer" });
    expect(settled.autoPicked).toBeUndefined();
    expect(settled.autoAnswerAt).toBeUndefined();
    await finish(bot.id);
  }, 60_000);

  it("leaves an approval waiting for the person", async () => {
    const { bot, requestId, replies } = await dogAsks({
      tool: "Bash",
      input: { command: "git push --no-verify origin fix/login" },
    });
    const open = await card(bot.threadId, requestId);
    expect(open.requestType).toBe("permission");
    expect(open.autoAnswerAt).toBeUndefined();
    await new Promise((r) => setTimeout(r, WAIT_MS + 1_000));
    expect(replies.filter((entry) => entry.id === requestId)).toEqual([]);
    const still = await card(bot.threadId, requestId);
    expect(still.answered).toBeUndefined();
    expect(still.autoPicked).toBeUndefined();
    await finish(bot.id);
  }, 60_000);

  it("drops the countdown when later.dog stops suddenly, since no turn is left waiting on the answer", async () => {
    const { bot, requestId } = await dogAsks({
      kind: "question",
      tool: "AskUserQuestion",
      input: { questions: [branch] },
    });
    expect((await card(bot.threadId, requestId)).autoAnswerAt).toBeGreaterThan(Date.now());
    await stopServer("SIGKILL");
    await startServer();
    const after = await card(bot.threadId, requestId);
    expect(after).toMatchObject({ requestId });
    expect(after.autoAnswerAt).toBeUndefined();
    expect(after.autoPicked).toBeUndefined();
  }, 60_000);
});
