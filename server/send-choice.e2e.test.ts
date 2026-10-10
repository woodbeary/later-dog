import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const posixOnly = describe.skipIf(process.platform === "win32");

posixOnly("choosing how a message reaches a working dog", () => {
  let child: ChildProcess;
  let home: string;
  let gate: string;
  let stderr = "";

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
  const texts = async (id: string) =>
    (await getBot(id)).messages.filter((m: any) => m.kind === "text").map((m: any) => `${m.role}:${m.text}`).slice(1);
  const workingBot = async () => {
    rmSync(gate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeGated", model: "claude-fake" } });
    const instances = (await api("GET", "/api/instances")).body.instances;
    expect(instances.find((i: any) => i.instanceId === "claudeGated").capabilities.queueing).toBe(true);
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "first" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === true, "the turn to start");
    await waitFor(async () => (await getBot(created.id)).messages.some((m: any) => m.kind === "activity"), "the tool chip");
    return created;
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-send-choice-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    gate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claudeGated: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate },
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
    for (;;) {
      const up = await fetch(`${BASE}/api/health`).then((res) => res.ok, () => false);
      if (up) break;
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

  it("Queue keeps the words for their own turn, even on an engine that could steer them in", async () => {
    const created = await workingBot();
    let queued: Awaited<ReturnType<typeof api>>;
    try {
      queued = await api("POST", `/api/bots/${created.id}/messages`, { text: "after that", threadId: created.threadId, deliver: "queue" });
      expect(queued.status).toBe(202);
      expect(queued.body).toMatchObject({ ok: true, queued: true });
      expect(queued.body.steered).toBeUndefined();
      expect((await getBot(created.id)).busy).toBe(true);
      expect(await texts(created.id)).not.toContain("user:after that");
    } finally {
      writeFileSync(gate, "finish");
    }
    await waitFor(async () => (await texts(created.id)).includes("bot:reply to: after that"), "the queued words to run");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the queued turn to settle");
    expect(await texts(created.id)).toEqual([
      "user:first",
      "bot:hello from fake claude",
      "bot:reply to: first",
      "user:after that",
      "bot:hello from fake claude",
      "bot:reply to: after that",
    ]);
  }, 40_000);

  it("Stop and send ends the running turn and runs the words next", async () => {
    const created = await workingBot();
    const stopped = await api("POST", `/api/bots/${created.id}/messages`, { text: "do this instead", threadId: created.threadId, deliver: "stop" });
    expect(stopped.status).toBe(202);
    expect(stopped.body).toMatchObject({ ok: true, queued: true });
    await waitFor(async () => (await texts(created.id)).includes("user:do this instead"), "the words to start their own turn");
    writeFileSync(gate, "finish");
    await waitFor(async () => (await texts(created.id)).includes("bot:reply to: do this instead"), "the new turn's reply");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the new turn to settle");
    const transcript = await texts(created.id);
    expect(transcript.some((text: string) => text.startsWith("bot:reply to: first"))).toBe(false);
    expect(transcript.indexOf("user:do this instead")).toBeGreaterThan(transcript.indexOf("user:first"));
    expect(transcript.at(-1)).toBe("bot:reply to: do this instead");
  }, 40_000);

  it("Stop and send to a dog that has just finished sends without stopping anything", async () => {
    writeFileSync(gate, "finish");
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeGated", model: "claude-fake" } });
    const sent = await api("POST", `/api/bots/${created.id}/messages`, { text: "hello", threadId: created.threadId, deliver: "stop" });
    expect(sent.status).toBe(202);
    expect(sent.body.queued).toBeUndefined();
    await waitFor(async () => (await texts(created.id)).includes("bot:reply to: hello"), "the reply");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
  }, 40_000);

  it("refuses a delivery it does not know", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    const refused = await api("POST", `/api/bots/${created.id}/messages`, { text: "hello", deliver: "later" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("deliver must be steer, queue or stop");
    expect(await texts(created.id)).toEqual([]);
  });
});
