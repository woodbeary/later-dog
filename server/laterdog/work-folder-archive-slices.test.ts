import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkFolderArchive } from "./work-folder-archive.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it("the timed sweep builds its chat list in slices instead of in one block", async () => {
  const root = mkdtempSync(join(tmpdir(), "work-folder-slices-"));
  dirs.push(root);
  mkdirSync(join(root, "data", "task-workspaces"), { recursive: true });
  let sliced = 0;
  const archive = new WorkFolderArchive({
    home: root, dataDir: join(root, "data"), workspacesDir: join(root, "data", "task-workspaces"),
    bridge: { archive: async () => ({ archived: 0, bytes: 0 }), restoreContaining: async () => ({ restored: 0, failed: 0 }) },
    chats: () => { throw new Error("the whole list was built in one block"); },
    chatsInSlices: async () => { sliced += 1; return []; },
    live: () => [], limits: () => ({ idleMs: 1, byteLimit: 1024, minFiles: 0, minBytes: 0 }), room: () => true,
  });
  expect(await archive.sweep()).toBe(0);
  expect(sliced).toBe(1);
});
