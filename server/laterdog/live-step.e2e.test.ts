import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { leasePortBlock } from "../testing/ports.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = await leasePortBlock([0, 1]);
const BASE = `http://127.0.0.1:${PORT}`;
const TOOL_CALLS = JSON.stringify([
  {
    name: "Read",
    input: { file_path: "/srv/shop/src/OrderForm.tsx" },
    output: "export function OrderForm() {}",
  },
  {
    name: "Edit",
    input: {
      file_path: "/srv/shop/docs/spring-menu.md",
      old_string: "Soup",
      new_string: "Spring soup",
    },
    output: "Edited",
  },
  {
    name: "Bash",
    input: { command: "pnpm test order-form", description: "Run the order form tests" },
    pending: true,
  },
]);

describe.skipIf(process.platform === "win32")("the live step a dog and a task carry", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let finishGate: string;

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
  const getBot = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === id);
  const liveRun = async (threadId: string) =>
    (await api("GET", `/api/threads/${threadId}/runs`)).body.runs?.[0];
  const waitFor = async (predicate: () => Promise<boolean>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const runningCommand = async (threadId: string) => {
    await waitFor(
      async () => (await liveRun(threadId))?.currentActivity?.label === "Bash",
      "the command to start",
    );
    const run = await liveRun(threadId);
    const detail = (await api("GET", `/api/threads/${threadId}/runs/${run.id}`)).body;
    return { run, activities: detail.activities as any[] };
  };

  beforeAll(async () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    home = mkdtempSync(join(tmpdir(), "laterdog-live-step-"));
    mkdirSync(join(home, ".laterdog"), { recursive: true });
    finishGate = join(home, "finish-turn.gate");
    writeFileSync(
      join(home, ".laterdog", "config.json"),
      JSON.stringify({
        instances: {
          claudeSteps: {
            driver: "claudeAgent",
            environment: {
              FAKE_CLAUDE_MODE: "slow",
              FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate,
              FAKE_CLAUDE_TOOL_CALLS: TOOL_CALLS,
            },
            config: { cli: FAKE_CLAUDE, permissionMode: "bypassPermissions" },
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

  it("sends the dog's live step, when it started and last moved, and what each step is about", async () => {
    rmSync(finishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claudeSteps", model: "claude-fake" },
    });
    expect(
      (await api("POST", `/api/bots/${created.id}/messages`, { text: "check the order form" }))
        .status,
    ).toBe(202);
    const { run, activities } = await runningCommand(created.threadId);
    expect(run.currentActivity).toEqual(
      expect.objectContaining({ label: "Bash", state: "running", startedAt: expect.any(Number) }),
    );
    expect(run.lastActivityAt).toBeGreaterThanOrEqual(run.currentActivity.startedAt);
    expect(
      activities.filter((row) => row.kind === "tool").map((row) => [row.label, row.subject]),
    ).toEqual([
      ["Read", "order form"],
      ["Edit", "spring menu"],
      ["Bash", "Run the order form tests"],
    ]);
    expect((await getBot(created.id)).step).toEqual({
      id: run.currentActivity.id,
      kind: "running",
      startedAt: run.currentActivity.startedAt,
      lastActivityAt: run.lastActivityAt,
    });

    writeFileSync(finishGate, "finish");
    await waitFor(async () => (await getBot(created.id)).busy === false, "the turn to settle");
    expect((await getBot(created.id)).step).toBeNull();
  }, 60_000);

  it("sends a task's live step with the task", async () => {
    rmSync(finishGate, { force: true });
    const created = (await api("POST", "/api/bots")).body.bot;
    await api("PATCH", `/api/bots/${created.id}`, {
      modelSelection: { instanceId: "claudeSteps", model: "claude-fake" },
    });
    const task = (await api("POST", `/api/bots/${created.id}/tasks`, { title: "Order form" })).body
      .task;
    expect(
      (
        await api("POST", `/api/bots/${created.id}/messages`, {
          text: "check the order form",
          threadId: task.threadId,
        })
      ).status,
    ).toBe(202);
    const { run } = await runningCommand(task.threadId);
    const carried = (await getBot(created.id)).tasks.find(
      (row: any) => row.threadId === task.threadId,
    );
    expect(carried.step).toEqual({
      id: run.currentActivity.id,
      kind: "running",
      startedAt: run.currentActivity.startedAt,
      lastActivityAt: run.lastActivityAt,
    });
    expect((await getBot(created.id)).step).toBeNull();

    writeFileSync(finishGate, "finish");
    await waitFor(
      async () =>
        !(await getBot(created.id)).tasks.find((row: any) => row.threadId === task.threadId)?.busy,
      "the task to settle",
    );
    expect(
      (await getBot(created.id)).tasks.find((row: any) => row.threadId === task.threadId).step,
    ).toBeNull();
  }, 60_000);
});
