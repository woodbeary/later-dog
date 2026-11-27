import { afterAll, describe, expect, it, vi } from "vitest";

const touched: Array<{ call: string; path: string }> = [];
const roots: string[] = [];

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  const watched = Object.fromEntries(Object.entries(real).map(([name, value]) => {
    if (!name.endsWith("Sync") || typeof value !== "function") return [name, value];
    const wrapped = (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "string" && roots.some((root) => first === root || first.startsWith(`${root}/`))) touched.push({ call: name, path: first });
      return (value as (...inner: unknown[]) => unknown)(...args);
    };
    return [name, wrapped];
  }));
  return { ...watched, default: { ...real, ...watched } };
});

const workspace = await import("./workspace.ts");
const store = await import("./memory-store.ts");
const journal = await import("./memory-journal.ts");
roots.push(workspace.WORKSPACES_DIR, workspace.TASK_WORKSPACES_DIR);

const bot = `mount-writes-${process.pid}`;

afterAll(async () => {
  const { rmSync } = await vi.importActual<typeof import("node:fs")>("node:fs");
  rmSync(workspace.workspaceDir(bot), { recursive: true, force: true });
  rmSync(workspace.taskWorkspacePath(bot, "thread-1"), { recursive: true, force: true });
});

describe("memory writes and folder setup on a dog's mounted folder", () => {
  it("never call a synchronous file-system function on the dog's folder", async () => {
    await workspace.ensureWorkspaceReady(bot);
    await workspace.ensureTaskWorkspaceReady(bot, "thread-1");
    expect((await workspace.updateMemory(bot, { action: "append", text: "The person likes tea" })).ok).toBe(true);
    expect((await workspace.updateMemory(bot, { action: "replace", oldText: "likes tea", text: "likes green tea" })).ok).toBe(true);
    expect((await workspace.appendMemoryLog(bot, "met the person")).ok).toBe(true);
    await workspace.writeMemoryTopic(bot, "places.md", "- Berlin\n");
    await workspace.writeMemoryLog(bot, "2026-11-27.md", "- 01:00 · a note\n");
    await workspace.appendMemoryArchive(bot, ["- 2026-01-01 · old"]);
    await workspace.writeMemoryFile(bot, "# Memory\n- fact\n");
    const written = await journal.journalMemoryWrite(bot, "memory/people.md", "- Sam\n", { actor: "person", via: "api" });
    await store.writeMemoryDoc(bot, "memory/log/2026-11-26.md", "- note\n");
    await journal.journalMemoryDelete(bot, "memory/people.md", { actor: "person", via: "ui" });
    expect(written.entry).not.toBeNull();
    expect((await journal.revertMemoryChange(bot, written.entry!.id)).ok).toBe(true);
    expect(touched).toEqual([]);
  });
});
