import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { RESTART_EXIT_CODE } from "../server/restart.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";
import { checkTrip, TRIP_DOGS } from "./cloud-home-trip-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MACHINE = "h0123456789abcdef01234567";
const HOST = `${MACHINE}-home.later.dog`;
const ORIGIN = `https://${HOST}`;
const SECRET = randomBytes(32).toString("base64url");
const OFFLINE = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => new Response("offline fixture", { status: 503 });')}`;
const BEHIND_CADDY = { "x-forwarded-for": "203.0.113.5", "x-forwarded-proto": "https", "x-forwarded-host": HOST };

interface Home { dir: string; base: string; env: NodeJS.ProcessEnv; child?: ChildProcess; boots: number; closing: boolean; log: string; failure?: Error }
let home: Home;

async function boot(fixture: Home): Promise<void> {
  const child = spawn(process.execPath, ["--import", OFFLINE, join(ROOT, "server", "index.ts")], { cwd: ROOT, env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
  fixture.child = child;
  fixture.boots++;
  child.stdout?.on("data", (chunk) => { fixture.log += chunk; });
  child.stderr?.on("data", (chunk) => { fixture.log += chunk; });
  child.once("exit", (code) => {
    if (code === RESTART_EXIT_CODE && !fixture.closing && fixture.child === child) boot(fixture).catch((error: Error) => { fixture.failure = error; });
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (fixture.closing || fixture.child !== child) return;
    if (child.exitCode !== null) throw new Error(`the home fixture exited:\n${fixture.log}`);
    try {
      const response = await fetch(`${fixture.base}/api/health`);
      if (response.ok && (await response.json() as { app?: string }).app === "laterdog") return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`the home fixture did not start:\n${fixture.log}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-trip-home-"));
  const dataDir = join(dir, ".laterdog");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    ...Object.fromEntries(["codex", "chatgpt", "cursor", "grok", "kimi", "droid", "antigravity", "opencodeGo", "openaiCompat", "qwen", "hermes", "pi"]
      .map((id) => [id, { driver: "not-a-real-driver" }])),
    claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") } },
  } }));
  const port = await freePortBlock([0, 1]);
  const env: NodeJS.ProcessEnv = {
    PATH: dirname(process.execPath),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: dir, USERPROFILE: dir, LATERDOG_HOME: dataDir, LATERDOG_SERVER_PORT: String(port), LATERDOG_WEBHOOK_PORT: String(port + 1),
    LATERDOG_TEST_SEALED_PATH: "1", FAKE_CLAUDE_AUTH: "out", FAKE_CLAUDE_MODE: "not-logged-in",
    LATERDOG_CLOUD_ROLE: "home", LATERDOG_CLOUD_MACHINE_ID: MACHINE, LATERDOG_CLOUD_ADMIN_URL: "https://accounts.example.test",
    LATERDOG_CLOUD_BOOTSTRAP_SECRET: SECRET, LATERDOG_PUBLIC_URL: ORIGIN,
  };
  home = { dir, base: `http://127.0.0.1:${port}`, env, boots: 0, closing: false, log: "" };
  await boot(home);
}, 60_000);

afterAll(async () => {
  if (!home) return;
  home.closing = true;
  await waitForExit(home.child, { signal: "SIGTERM" });
  await removeTempDir(home.dir);
  if (home.failure) throw home.failure;
});

it("carries a desktop's three dogs and their chats to a Cloud home, does not copy again on the next sign-in, and a phone's message comes back", async () => {
  const lines: string[] = [];
  const summary = await checkTrip({ homeUrl: home.base, homeOrigin: ORIGIN, secret: SECRET, edgeHeaders: BEHIND_CADDY, log: (line: string) => lines.push(line) })
    .catch((error: Error) => { throw new Error(`${error.message}\n${lines.join("\n")}\n--- home ---\n${home.log.slice(-4000)}`); });
  expect(summary.dogs).toEqual([...TRIP_DOGS].sort());
  expect(summary.chats).toBe(3);
  expect(summary.moved).toMatchObject({ bots: 3, rooms: 0, chats: 3 });
  expect(summary.phone).toMatchObject({ dog: "Trip Planner" });
  expect(home.boots, "only the first trip restarts the home").toBe(2);
  expect(lines.join("\n")).toContain("second sign-in: nothing copied again");
}, 240_000);
