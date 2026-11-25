import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leasePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = await leasePortBlock([0, 1]);
const BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === "win32")("a saved command sent with /name", () => {
  let child: ChildProcess;
  let home: string;
  let prompts: string;
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
  const sent = () => (existsSync(prompts) ? readFileSync(prompts, "utf8") : "");

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-slash-"));
    prompts = join(home, "prompts.jsonl");
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claudeSlash: {
            driver: "claudeAgent",
            environment: { FAKE_CLAUDE_PROMPTS: prompts },
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

  it("sends the saved text with the person's words to the dog, keeps it in the chat, and leaves other slashes alone", async () => {
    expect((await api("POST", "/api/commands", { name: "plan", text: "Write a plan first, then wait for my go." })).status).toBe(201);
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeSlash", model: "claude-fake" } });
    const listed = (await api("GET", `/api/bots/${created.id}/commands`)).body.commands;
    expect(listed[0]).toEqual({ name: "plan", line: "Write a plan first, then wait for my go.", kind: "mine", text: "Write a plan first, then wait for my go." });

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "/plan for the login page" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === false && sent().includes("login page"), "the first turn");
    expect(sent()).toContain("Write a plan first, then wait for my go.\\n\\nfor the login page");
    const first = (await getBot(created.id)).messages.filter((m: any) => m.role === "user").at(-1);
    expect(first.text).toBe("Write a plan first, then wait for my go.\n\nfor the login page");

    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "/etc/hosts looks wrong" })).status).toBe(202);
    await waitFor(async () => (await getBot(created.id)).busy === false && sent().includes("hosts looks wrong"), "the second turn");
    const second = (await getBot(created.id)).messages.filter((m: any) => m.role === "user").at(-1);
    expect(second.text).toBe("/etc/hosts looks wrong");
  }, 60_000);
});
