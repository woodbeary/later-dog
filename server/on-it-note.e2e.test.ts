import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ON_IT_NOTE } from "./laterdog/work-updates.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFLINE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
const FAKE_CLAUDE = join(ROOT, "server", "testing", "fake-claude-cli.ts");

let dir = "";
let child: ChildProcess;
let base = "";
let log = "";
let promptsFile = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "laterdog-on-it-"));
  const dataDir = join(dir, ".laterdog");
  promptsFile = join(dir, "prompts.jsonl");
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
      LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1), FAKE_CLAUDE_PROMPTS: promptsFile,
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

it("asks a dog to say it's on it on a person's message, and not on a routine run", async () => {
  const ask = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json() as Promise<any>;
  };
  const until = async (ready: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`${what} never happened\n${log.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const sent = () => existsSync(promptsFile) ? readFileSync(promptsFile, "utf8").trim().split("\n").filter(Boolean) : [];
  const { bot: dog } = await ask("POST", "/api/bots", { name: "Pip" });
  await ask("PATCH", `/api/bots/${dog.id}`, { modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, browser: false });

  await ask("POST", `/api/bots/${dog.id}/messages`, { text: "Which branch is the repo on?", threadId: dog.threadId });
  await until(async () => sent().length === 1, "the person's turn");

  const { routine } = await ask("POST", "/api/routines", {
    botId: dog.id, name: "Morning check", prompt: "Check the repo's branch.", enabled: false,
    schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
  });
  const { run } = await ask("POST", `/api/routines/${routine.id}/run`, {});
  await until(async () => {
    const found = (await ask("GET", "/api/routines")).runs.find((candidate: { id: string }) => candidate.id === run.id);
    return Boolean(found) && !["queued", "running", "waiting"].includes(found.status);
  }, "the routine run");

  const [person, routineTurn] = sent();
  expect(person).toContain("Which branch is the repo on?");
  expect(JSON.parse(person).message.content).toMatch(new RegExp(`${ON_IT_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  expect(routineTurn).toContain("Check the repo's branch.");
  expect(routineTurn).not.toContain(ON_IT_NOTE);
}, 120_000);
