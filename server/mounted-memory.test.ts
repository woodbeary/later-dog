import { vi, it, expect } from "vitest";
import { join } from "node:path";

const failure = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    if (failure.path && args[0] === failure.path) throw Object.assign(new Error("working folder offline"), { code: "EIO" });
    return fs.readFileSync(...args);
  } };
});

vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: (...args: Parameters<typeof fs.readFile>) => {
    if (failure.path && args[0] === failure.path) return Promise.reject(Object.assign(new Error("working folder offline"), { code: "EIO" }));
    return fs.readFile(...args);
  } };
});

import { MOUNT_COOL_MS, MountDown } from "./laterdog/mount-guard.ts";
import { beginMemoryTurnInBackground, endMemoryTurnInBackground, journalMemoryWrite } from "./memory-journal.ts";
import { memoryOverview, readMemoryDoc, writeMemoryDoc } from "./memory-store.ts";
import { readMemoryFile, workspaceDir } from "./workspace.ts";

it("keeps the file and its journal baseline when a mounted folder cannot be read", async () => {
  const bot = "storage-interruption";
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    await journalMemoryWrite(bot, "MEMORY.md", "remember this", { actor: "person", via: "api" });
    await beginMemoryTurnInBackground(bot, "busy");
    failure.path = join(workspaceDir(bot), "MEMORY.md");
    await expect(memoryOverview(bot)).rejects.toBeInstanceOf(MountDown);
    expect(() => readMemoryFile(bot)).toThrow(MountDown);
    await expect(readMemoryDoc(bot, "MEMORY.md")).rejects.toBeInstanceOf(MountDown);
    await expect(writeMemoryDoc(bot, "MEMORY.md", "wrong")).rejects.toBeInstanceOf(MountDown);
    expect(await endMemoryTurnInBackground("busy")).toEqual([]);
    failure.path = "";
    vi.setSystemTime(Date.now() + MOUNT_COOL_MS + 1);
    expect((await readMemoryDoc(bot, "MEMORY.md")).text).toBe("remember this");
    expect((await readMemoryDoc(bot, "memory/missing.md")).exists).toBe(false);
    await beginMemoryTurnInBackground(bot, "healthy");
    expect(await endMemoryTurnInBackground("healthy")).toEqual([]);
  } finally {
    failure.path = "";
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
