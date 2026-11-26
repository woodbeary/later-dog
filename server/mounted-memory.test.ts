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

import { beginMemoryTurn, endMemoryTurn, journalMemoryWrite } from "./memory-journal.ts";
import { memoryOverview, readMemoryDoc, writeMemoryDoc } from "./memory-store.ts";
import { readMemoryFile, workspaceDir } from "./workspace.ts";

it("keeps the file and its journal baseline when a mounted folder cannot be read", () => {
  const bot = "storage-interruption";
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
  try {
    journalMemoryWrite(bot, "MEMORY.md", "remember this", { actor: "person", via: "api" });
    beginMemoryTurn(bot, "busy");
    failure.path = join(workspaceDir(bot), "MEMORY.md");
    expect(() => memoryOverview(bot)).toThrow("working folder offline");
    expect(() => readMemoryFile(bot)).toThrow("working folder offline");
    expect(() => readMemoryDoc(bot, "MEMORY.md")).toThrow("working folder offline");
    expect(() => writeMemoryDoc(bot, "MEMORY.md", "wrong")).toThrow("working folder offline");
    expect(endMemoryTurn("busy")).toEqual([]);
    failure.path = "";
    expect(readMemoryDoc(bot, "MEMORY.md").text).toBe("remember this");
    expect(readMemoryDoc(bot, "memory/missing.md").exists).toBe(false);
    beginMemoryTurn(bot, "healthy");
    expect(endMemoryTurn("healthy")).toEqual([]);
  } finally {
    failure.path = "";
    vi.unstubAllEnvs();
  }
});
