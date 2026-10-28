import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
const FAKE_CLAUDE = join(ROOT, "server", "testing", "fake-claude-cli.ts");

let dir = "";
let child: ChildProcess;
let base = "";
let log = "";
let dumpFile = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "laterdog-warm-session-"));
  const dataDir = join(dir, ".laterdog");
  dumpFile = join(dir, "launch.json");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: FAKE_CLAUDE } },
  } }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", OFFLINE, join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      PATH: dirname(process.execPath), HOME: dir, USERPROFILE: dir, LATERDOG_HOME: dataDir,
      LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
      FAKE_CLAUDE_REPLIES: JSON.stringify(["first answer", "second answer", "third answer"]), FAKE_CLAUDE_DUMP: dumpFile,
      LATERDOG_CLOUD_BOAT_URL: "https://boat.example.test/relay/api/box/v1", LATERDOG_CLOUD_BOAT_TOKEN: "box_laterdog_fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server fixture exited:\n${log}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error(`the server fixture did not start:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 60_000);

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (dir) await removeTempDir(dir);
});

type Entry = { kind: string; data?: { source?: string; msg?: { close?: string } } };

it("keeps a dog's engine and its cloud computer tools running from one message to the next", async () => {
  const ask = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json() as Promise<any>;
  };
  const { bot: dog } = await ask("POST", "/api/bots", { name: "Warm" });
  await ask("PATCH", `/api/bots/${dog.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, browser: false, computer: null });
  const idle = async () => {
    const deadline = Date.now() + 30_000;
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (;;) {
      const current = (await ask("GET", "/api/bots?messages=0")).bots.find((bot: { id: string }) => bot.id === dog.id);
      if (!current.busy) return;
      if (Date.now() > deadline) throw new Error(`the dog stayed busy\n${log.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const launches: { pid: number; computer: boolean }[] = [];
  for (const text of ["hello", "and again"]) {
    await ask("POST", `/api/bots/${dog.id}/messages`, { text, threadId: dog.threadId });
    await idle();
    const launch = JSON.parse(readFileSync(dumpFile, "utf8"));
    launches.push({ pid: launch.pid, computer: Boolean(launch.mcpConfig?.mcpServers?.computer) });
  }
  const page = await ask("GET", `/api/threads/${dog.threadId}/events?limit=500`);
  const closes = (page.entries as Entry[]).filter((entry) => entry.kind === "native" && entry.data?.source === "claude.session").map((entry) => entry.data?.msg?.close);
  const answers = (await ask("GET", `/api/threads/${dog.threadId}/messages`)).messages.filter((message: { role: string; kind?: string }) => message.role === "bot" && message.kind === "text").map((message: { text: string }) => message.text);
  expect(answers.slice(-2)).toEqual(["first answer", "second answer"]);
  expect(launches[0].computer, "the dog has its cloud computer's tools").toBe(true);
  expect(closes, "the second message reused the running engine").toEqual([]);
  expect(launches[1]).toEqual(launches[0]);
}, 120_000);
