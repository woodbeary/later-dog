import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stillStoppingReason } from "./queued-steer.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === "win32")("Steer on a turn that will not stop", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let promptDump: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const listing = async () => (await api("GET", "/api/bots")).body;
  const getBot = async (id: string) => (await listing()).bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-stuck-steer-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    promptDump = join(home, "acp-dump");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          stubborn: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "hang", FAKE_ACP_IGNORE_CANCEL: "1", FAKE_ACP_DUMP: promptDump, FAKE_ACP_DUMP_PROMPT: "1" },
            config: { cli: FAKE_ACP, fullAuto: true },
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
        LATERDOG_QUEUED_STEER_SETTLE_MS: "300",
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
    child?.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      child.on("close", () => resolve());
      setTimeout(() => (child.kill("SIGKILL"), resolve()), 5_000).unref?.();
    });
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("answers with one plain line, keeps the message queued, and sends it once when the turn finally stops", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "stubborn", model: "fake-model" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "keep going" })).status).toBe(202);
    await waitFor(async () => existsSync(`${promptDump}.prompt.json`), "the stubborn turn to reach the engine");
    const queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "hello" });
    expect(queued.body).toMatchObject({ ok: true, queued: true });

    const answer = await api("POST", `/api/bots/${created.id}/queue/${queued.body.queueId}/steer`, { threadId: created.threadId });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, queued: true, threadId: created.threadId, reason: stillStoppingReason(created.name) });
    expect((await listing()).botQueuedMessages[created.threadId]).toEqual([
      expect.objectContaining({ queueId: queued.body.queueId, text: "hello" }),
    ]);
    expect((await getBot(created.id)).messages.some((m: any) => m.text === "hello")).toBe(false);

    await waitFor(
      async () => (await getBot(created.id)).messages.some((m: any) => m.role === "user" && m.text === "hello"),
      "the queued message to go once the turn stops",
    );
    const lines = (await getBot(created.id)).messages.filter((m: any) => m.role === "user" && m.text === "hello");
    expect(lines).toHaveLength(1);
    expect(lines[0].queueId).toBe(queued.body.queueId);
    expect((await listing()).botQueuedMessages[created.threadId] ?? []).toEqual([]);

    await api("POST", `/api/bots/${created.id}/interrupt`);
    await waitFor(async () => (await getBot(created.id)).busy === false, "the next turn to settle");
  }, 60_000);
});
