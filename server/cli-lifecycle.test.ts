import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWorkspaceRunning, runOnboardingCommand, runServe, type CliOptions } from "./cli.ts";

const mocks = vi.hoisted(() => ({
  denyLogOpen: false,
  spawn: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (mocks.denyLogOpen && String(args[0]).endsWith(".log")) {
        throw Object.assign(new Error("Fixture log permission denied"), { code: "EACCES" });
      }
      return fs.openSync(...args);
    },
  };
});
vi.mock("./browser-engine.ts", () => ({
  browserEngineStatus: () => ({ kind: "ready" }), describeBrowserEngine: () => "Fixture browser ready",
}));
vi.mock("./cli-setup.ts", () => ({
  runSetup: () => { throw new Error("An existing workspace must not rerun setup"); },
}));

const workspaceId = "4e406646-1030-4613-8878-e227ab722ffc";
const childPid = process.pid + 1;
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
let dataDir: string;
let options: CliOptions;
let signalListeners: Map<NodeJS.Signals, Set<unknown>>;
const children: ChildProcess[] = [];

function childProcess(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid: childPid,
    kill: vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    }),
  }) as unknown as ChildProcess;
  children.push(child);
  return child;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.denyLogOpen = false;
  dataDir = mkdtempSync(join(process.env.HOME!, "cli-lifecycle-"));
  options = { command: "serve", port: 18451, dataDir, client: false, pair: false, json: false, guided: true, open: false };
  signalListeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal as NodeJS.Signals, new Set(process.listeners(signal))]));
  mocks.spawn.mockImplementation(() => childProcess());
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected fixture request"); }));
});

afterEach(() => {
  for (const child of children.splice(0)) child.emit("exit", 0, null);
  for (const [signal, before] of signalListeners) {
    for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const [index, stream] of [process.stdin, process.stdout].entries()) {
    const descriptor = ttyDescriptors[index];
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else Reflect.deleteProperty(stream, "isTTY");
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CLI startup lifecycle", () => {
  it("spawns no server when guided logs cannot be opened", async () => {
    mocks.denyLogOpen = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 503 })));
    await expect(runServe(options, vi.fn())).rejects.toMatchObject({ code: "EACCES" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("reopens a matching desktop workspace even when its server PID differs from the lease owner", async () => {
    writeFileSync(join(dataDir, "environment-id"), workspaceId);
    writeFileSync(join(dataDir, "laterdog-server.lease"), JSON.stringify({
      version: 1, pid: process.pid, host: hostname(), token: workspaceId, createdAt: Date.now(),
    }));
    vi.stubEnv("LATERDOG_HOME", process.env.LATERDOG_HOME);
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { value: true, configurable: true });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/health")
      ? Response.json({ app: "laterdog", pid: childPid })
      : Response.json({ environmentId: workspaceId })));
    const start = vi.fn();
    const open = vi.fn().mockResolvedValue(true);
    const io = { log: vi.fn(), error: vi.fn(), ask: vi.fn() };
    expect(await runOnboardingCommand({ ...options, command: "start", open: true }, io, start, { open })).toBe(0);
    expect(open).toHaveBeenCalledWith(options.port);
    expect(start).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not mistake another workspace on the same port for this one", async () => {
    writeFileSync(join(dataDir, "environment-id"), workspaceId);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ app: "laterdog", pid: childPid }))
      .mockResolvedValueOnce(Response.json({ environmentId: "different-workspace" })));
    expect(await isWorkspaceRunning(options)).toBe(false);
  });
});
