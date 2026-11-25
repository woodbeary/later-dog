import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkspaceBackupSnapshot, stageWorkspaceBackup } from "./workspace-backup.ts";

const moving = vi.hoisted(() => ({
  dir: "",
  record: "",
  file: "",
  offloaded: false,
  restored: false,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const listed = actual.readdirSync as (...args: unknown[]) => unknown[];
  const readdirSync = ((...args: unknown[]) => {
    const names = listed(...args);
    if (String(args[0]) === moving.dir && !moving.offloaded) {
      actual.writeFileSync(moving.record + ".next", '{"chat/thread":{"cleared":true}}');
      actual.renameSync(moving.record + ".next", moving.record);
      actual.rmSync(moving.file);
      moving.offloaded = true;
    }
    return names;
  }) as typeof actual.readdirSync;
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    if (String(args[0]) === moving.record && moving.offloaded && !moving.restored) {
      actual.writeFileSync(moving.file, "synthetic work restored during backup\n");
      actual.writeFileSync(moving.record + ".next", "{}");
      actual.renameSync(moving.record + ".next", moving.record);
      moving.restored = true;
    }
    return actual.openSync(...args);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, readdirSync, openSync }, readdirSync, openSync };
});
const roots: string[] = [];
afterEach(() => {
  Object.assign(moving, { dir: "", record: "", file: "", offloaded: false, restored: false });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "backup-storage-cycle-")));
  roots.push(root);
  return root;
}

it("refuses a backup whose files moved into and out of storage while its snapshot was collected", async () => {
  const root = directory();
  moving.dir = join(root, "task-workspaces", "chat", "thread");
  moving.record = join(root, "work-folders.json");
  moving.file = join(moving.dir, "result.txt");
  mkdirSync(moving.dir, { recursive: true });
  writeFileSync(moving.file, "synthetic work restored during backup\n");
  writeFileSync(moving.record, "{}");
  const result = await createWorkspaceBackupSnapshot(root, {
    password: "synthetic backup password",
  }).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  expect(moving.offloaded).toBe(true);
  expect(moving.restored).toBe(true);
  expect(readFileSync(moving.file, "utf8")).toBe("synthetic work restored during backup\n");
  if (result.result) {
    const target = directory();
    const staged = await stageWorkspaceBackup(target, result.result.path, {
      password: "synthetic backup password",
    });
    console.info(
      JSON.stringify({
        sourceRestored: true,
        backupOmittedFile: !existsSync(
          join(
            target,
            ".backups",
            staged.id,
            "staged",
            "data",
            "task-workspaces",
            "chat",
            "thread",
            "result.txt",
          ),
        ),
      }),
    );
  }
  expect(result.error).toMatchObject({ message: expect.stringMatching(/storage changed/i) });
});
