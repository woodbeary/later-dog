import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === "win32")("what fills a chat's context window, on the fake engine", () => {
  let child: ChildProcess;
  let home: string;
  let seen: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any; text: string }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const dogOn = async (instanceId: string) => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model: "claude-fake" } });
    return { id: created.id as string, threadId: created.threadId as string };
  };
  const turn = async (botId: string, text: string) => {
    const before = (await getBot(botId)).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    await waitFor(async () => {
      const bot = await getBot(botId);
      return !bot.busy && bot.messages.filter((m: any) => m.role === "bot" && m.kind === "text").length > before;
    }, `the reply to "${text}"`);
  };
  const asked = () => (existsSync(seen) ? readFileSync(seen, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-chat-context-"));
    seen = join(home, "older-engine-asked.jsonl");
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claudeCounts: { driver: "claudeAgent", environment: {}, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } },
          claudeOlder: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_CONTEXT: "unknown", FAKE_CLAUDE_CONTEXT_SEEN: seen },
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
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("has nothing before the first reply, then reads the engine's own count back after a turn", async () => {
    const dog = await dogOn("claudeCounts");
    expect(await api("GET", `/api/threads/${dog.threadId}/context`)).toMatchObject({ status: 404, body: { error: "nothing yet" } });
    await turn(dog.id, "hello");
    await waitFor(async () => (await api("GET", `/api/threads/${dog.threadId}/context`)).status === 200, "the breakdown");
    const { body, text } = await api("GET", `/api/threads/${dog.threadId}/context`);
    expect(body).toMatchObject({ source: "engine", window: 200_000, compactsAt: 167_000, at: expect.any(Number) });
    expect(body.total).toBeGreaterThan(30_000);
    const used = body.parts.filter((part: any) => !part.deferred && part.id !== "reserve" && part.id !== "free");
    expect(used.reduce((sum: number, part: any) => sum + part.tokens, 0)).toBe(body.total);
    expect(body.parts.filter((part: any) => !part.deferred).reduce((sum: number, part: any) => sum + part.tokens, 0)).toBe(body.window);
    expect(body.parts).toContainEqual({ id: "tools", tokens: 41_000, deferred: true });
    expect(body.parts.map((part: any) => part.id)).toEqual(["conversation", "tools", "instructions", "skills", "memory", "reserve", "free", "tools"]);
    for (const leak of ["CLAUDE.md", "fixture-person", "fixture_private_tool", "FixturePrivateCommand", "System prompt", "claude-fake"]) expect(text).not.toContain(leak);
    expect(Object.keys(body).sort()).toEqual(["at", "compactsAt", "parts", "source", "total", "window"]);
  }, 60_000);

  it("keeps working on an engine that does not know the request, and asks it only once", async () => {
    const dog = await dogOn("claudeOlder");
    const replies = async () => (await getBot(dog.id)).messages.filter((m: any) => m.role === "bot" && m.kind === "text").length;
    const before = await replies();
    await turn(dog.id, "first");
    await waitFor(async () => asked().length > 0, "the one question");
    await turn(dog.id, "second");
    expect(await api("GET", `/api/threads/${dog.threadId}/context`)).toMatchObject({ status: 404, body: { error: "nothing yet" } });
    expect(asked()).toEqual([{ subtype: "get_context_usage", detail: "summary", turns: 1 }]);
    expect(await replies()).toBe(before + 2);
  }, 60_000);

  it("knows when a conversation is not a dog's", async () => {
    expect(await api("GET", "/api/threads/ghost-thread/context")).toMatchObject({ status: 404, body: { error: "no such conversation" } });
  });
});
