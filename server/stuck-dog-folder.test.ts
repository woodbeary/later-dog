import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const waking = vi.hoisted(() => `/workspaces/waking-${process.pid}`);
const onWakingFolder = vi.hoisted(() => (path: unknown) => typeof path === "string" && (path.includes(`${waking}/`) || path.endsWith(waking)));

vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const hung = Object.fromEntries(Object.entries(real).map(([name, value]) => [name, typeof value !== "function" ? value
    : (...args: unknown[]) => onWakingFolder(args[0]) ? new Promise(() => {}) : (value as (...inner: unknown[]) => unknown)(...args)]));
  return { ...hung, default: { ...real, ...hung } };
});

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const blocking = Object.fromEntries(Object.entries(real).map(([name, value]) => [name, !name.endsWith("Sync") || typeof value !== "function" ? value
    : (...args: unknown[]) => {
      if (onWakingFolder(args[0])) { const until = Date.now() + 2_000; while (Date.now() < until); }
      return (value as (...inner: unknown[]) => unknown)(...args);
    }]));
  return { ...blocking, default: { ...real, ...blocking } };
});

import { json, readBody } from "./harness/http.ts";
import { mountedFolderGate } from "./laterdog/mounted-folder-gate.ts";
import { prepareTurnFolders } from "./laterdog/turn-folders.ts";
import { beginMemoryTurnInBackground } from "./memory-journal.ts";
import { createBotMemoryRoutes } from "./routes/bot-memory.ts";
import { dispatchRoutes } from "./routes/table.ts";
import { MEMORY_SEED, workspaceDir } from "./workspace.ts";
import { DATA_DIR } from "./config.ts";
import { permissionLaunchCwd } from "./drivers/permission-command.ts";
import { botFolderPresent } from "./laterdog/engine-placement.ts";

const STUCK = `stuck-${process.pid}`;
const WAKING = waking.slice("/workspaces/".length);
const HEALTHY = `healthy-${process.pid}`;
const ANSWERS_AFTER_MS = 12_000;
const fifo = (dog = STUCK) => join(workspaceDir(dog), "MEMORY.md");
let server: Server;
let base = "";

beforeAll(async () => {
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
  mkdirSync(join(workspaceDir(STUCK), "memory"), { recursive: true });
  execFileSync("mkfifo", [fifo()]);
  mkdirSync(join(workspaceDir(HEALTHY), "memory"), { recursive: true });
  writeFileSync(join(workspaceDir(HEALTHY), "MEMORY.md"), "# Memory\n- likes tea\n");
  const routes = [createBotMemoryRoutes({
    bot: (id) => (id === STUCK || id === HEALTHY ? { id } : undefined), taskByThread: () => undefined,
    upkeep: { status: () => ({ modelSteps: false }), tidy: async () => ({}) as never },
    aboutMe: () => "", saveAboutMe: () => {},
  })];
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/health") return json(res, 200, { ok: true });
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, {});
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(workspaceDir(STUCK), { recursive: true, force: true });
  rmSync(workspaceDir(HEALTHY), { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function answerLater(dog: string): void {
  spawn("sh", ["-c", `sleep ${ANSWERS_AFTER_MS / 1000}; printf '# Memory\\n' > "$0"`, fifo(dog)], { stdio: "ignore", detached: true }).unref();
}

const timed = async (path: string) => {
  const began = Date.now();
  const response = await fetch(`${base}${path}`);
  await response.text();
  return { status: response.status, ms: Date.now() - began };
};

const p99 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.99))]!;

it("a stuck dog folder answers its memory route with 503 while health and other dogs stay fast", async () => {
  answerLater(STUCK);
  const stuck = timed(`/api/bots/${STUCK}/memory`);
  const health: number[] = [];
  const other: number[] = [];
  let done = false;
  void stuck.finally(() => { done = true; });
  while (!done) {
    health.push((await timed("/api/health")).ms);
    if (health.length % 10 === 0) {
      const reply = await timed(`/api/bots/${HEALTHY}/memory`);
      expect(reply.status).toBe(200);
      other.push(reply.ms);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const first = await stuck;
  const again = await timed(`/api/bots/${STUCK}/memory`);
  console.log(JSON.stringify({ healthSamples: health.length, healthP99Ms: p99(health), healthMaxMs: Math.max(...health), otherDogMaxMs: Math.max(...other), stuckFirst: first, stuckAgain: again }));
  expect(first.status).toBe(503);
  expect(first.ms).toBeLessThan(ANSWERS_AFTER_MS);
  expect(again.status).toBe(503);
  expect(again.ms).toBeLessThan(300);
  expect(health.length).toBeGreaterThan(50);
  expect(p99(health)).toBeLessThan(300);
  expect(Math.max(...other)).toBeLessThan(300);
}, 30_000);

it("a turn's folder phase on a dog whose folder hangs does not hold the event loop", async () => {
  let worst = 0;
  let last = Date.now();
  const sampler = setInterval(() => { const at = Date.now(); worst = Math.max(worst, at - last - 10); last = at; }, 10);
  const began = Date.now();
  let steps: PromiseSettledResult<unknown>[];
  try {
    steps = await Promise.allSettled([
      mountedFolderGate.answers(workspaceDir(WAKING)),
      prepareTurnFolders({ workspace: workspaceDir(WAKING), task: join(workspaceDir(WAKING), "..", "..", "task-workspaces", WAKING, "thread"), seed: { name: "MEMORY.md", text: MEMORY_SEED }, budgetMs: 2_000, gate: mountedFolderGate, active: true }),
      beginMemoryTurnInBackground(WAKING, "waking-thread"),
      botFolderPresent(DATA_DIR, WAKING),
      Promise.resolve(permissionLaunchCwd(workspaceDir(WAKING))()),
    ]);
  } finally {
    clearInterval(sampler);
  }
  const phaseMs = Date.now() - began;
  console.log(JSON.stringify({ folderPhaseMs: phaseMs, folderPhaseWorstLoopHoldMs: worst, steps: steps.map((step) => step.status === "fulfilled" ? step.value : String(step.reason).slice(0, 80)) }));
  expect(steps[0]).toEqual({ status: "fulfilled", value: false });
  expect(steps[1]!.status).toBe("rejected");
  expect(steps[2]).toEqual({ status: "fulfilled", value: null });
  expect(steps[3]).toEqual({ status: "fulfilled", value: false });
  expect(steps[4]).toEqual({ status: "fulfilled", value: workspaceDir(WAKING) });
  expect(phaseMs).toBeLessThan(ANSWERS_AFTER_MS);
  expect(worst).toBeLessThan(300);
}, 30_000);
