import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe.skipIf(process.platform === "win32")("a picture sent while a dog works", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const upload = async (): Promise<string> => {
    const res = await fetch(`${BASE}/api/attachments`, { method: "POST", headers: { "content-type": "image/png" }, body: PNG });
    expect(res.status).toBe(201);
    return ((await res.json()) as { path: string }).path;
  };
  const workingDog = async () => {
    rmSync(finishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSlow", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "work on it" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id))?.busy === true, "the dog to start working");
    return created.id as string;
  };
  const finishedReply = async (botId: string) => {
    writeFileSync(finishGate, "finish");
    await waitFor(async () => (await getBot(botId)).busy === false, "the turn to settle");
    const bot = await getBot(botId);
    return bot.messages.find((m: any) => m.role === "bot" && String(m.text).startsWith("reply to: work on it"));
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-steer-images-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claudeSlow: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
          },
        },
      }),
    );
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, LATERDOG_SERVER_PORT: String(PORT) },
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
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true });
  });

  it("steers the picture straight into the running turn", async () => {
    const botId = await workingDog();
    const path = await upload();
    const sent = await api("POST", `/api/bots/${botId}/messages`, {
      text: `what about this one\n\n<attached-image path="${path}" name="shot.png" />`,
    });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ steered: true });
    expect(sent.body.message).toMatchObject({ role: "user", steered: true });

    const reply = await finishedReply(botId);
    expect(reply?.text).toContain("+ steered:");
    expect(reply?.text).toContain("[image image/png]");
    expect(reply?.text).toContain("what about this one");
    const bot = await getBot(botId);
    expect(bot.queue ?? []).toEqual([]);
  }, 60_000);

  it("steers a queued picture when the person presses Steer", async () => {
    const botId = await workingDog();
    const path = await upload();
    const queued = await api("POST", `/api/bots/${botId}/messages`, {
      text: `<attached-image path="${path}" name="later.png" />`,
      deliver: "queue",
    });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ queued: true, queueId: expect.any(String) });

    const steered = await api("POST", `/api/bots/${botId}/queue/${queued.body.queueId}/steer`, { threadId: queued.body.threadId });
    expect(steered.status).toBe(200);
    expect(steered.body).toMatchObject({ steered: true, queueIds: [queued.body.queueId] });

    const reply = await finishedReply(botId);
    expect(reply?.text).toContain("[image image/png]");
  }, 60_000);
});
