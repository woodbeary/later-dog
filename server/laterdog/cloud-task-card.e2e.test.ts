import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobReceipt } from "./job-receipt.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const JOB_ID = "6a1f8f2e-1111-4222-8333-944444444444";
const RECEIPT = JSON.stringify(jobReceipt({
  requestKey: "card-request-1", repository: "owner/repo", title: "Fix the login button", brief: "Make it work", standingInstructions: "", writeScopes: ["src"],
  dependencies: [], profileId: "cloud", kind: "implementation", id: JOB_ID, state: "queued", backend: "laterdog-cloud", attempt: 1,
  createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", outputBranch: `laterdog/${JOB_ID}`,
}));
const TOOL_CALLS = JSON.stringify([
  { name: "mcp__laterdog__laterdog_workspace", output: [{ type: "text", text: JSON.stringify({ jobs: [] }) }] },
  { name: "mcp__laterdog__delegate_cloud_job", input: { title: "Fix the login button" }, ok: false, output: [{ type: "text", text: "This dog's access does not include that later.dog operation." }] },
  { name: "mcp__laterdog__delegate_cloud_job", input: { title: "Fix the login button" }, output: [{ type: "text", text: RECEIPT }] },
  { name: "mcp__laterdog__delegate_cloud_job", input: { title: "Fix the login button" }, output: [{ type: "text", text: RECEIPT }] },
  { name: "mcp__laterdog__inspect_cloud_job", input: { jobId: JOB_ID }, output: [{ type: "text", text: RECEIPT }] },
]);

describe.skipIf(process.platform === "win32")("cloud task cards in the chat that started them", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-cloud-card-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    writeFileSync(join(home, ".laterdog", "config.json"), JSON.stringify({
      instances: { claudeCards: { driver: "claudeAgent", environment: { FAKE_CLAUDE_TOOL_CALLS: TOOL_CALLS }, config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" } } },
    }));
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, LATERDOG_SERVER_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    while (!(await fetch(`${BASE}/api/health`).then((res) => res.ok, () => false))) {
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
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

  it("adds one card for the job a dog sent, after its tool call, and none for failed or read-only calls", async () => {
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId: "claudeCards", model: "claude-fake" } });
    expect((await api("POST", `/api/bots/${created.id}/messages`, { text: "send it to the cloud" })).status).toBe(202);
    const deadline = Date.now() + 30_000;
    let bot = await getBot(created.id);
    while ((bot.busy || !bot.messages.some((m: any) => m.text === "reply to: send it to the cloud")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      bot = await getBot(created.id);
    }
    const cards = bot.messages.filter((m: any) => m.cloudTask);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      role: "bot", kind: "activity",
      tool: { name: "Cloud task: Fix the login button", ok: true },
      cloudTask: { jobId: JOB_ID, title: "Fix the login button", repository: "owner/repo", backend: "laterdog-cloud" },
    });
    const order = bot.messages.map((m: any) => m.id);
    const delegated = bot.messages.filter((m: any) => m.tool?.name === "mcp__laterdog__delegate_cloud_job");
    expect(delegated.length).toBeGreaterThanOrEqual(2);
    expect(order.indexOf(cards[0].id)).toBeGreaterThan(order.indexOf(delegated[1].id));
  }, 60_000);
});
