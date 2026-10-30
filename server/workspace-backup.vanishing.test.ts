import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { workspaceMoveSize } from "./cloud-move.ts";
import { createWorkspaceBackupSnapshot } from "./workspace-backup.ts";

const renamedAway = vi.hoisted(() => ({ directory: "", name: "" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const listed = actual.readdirSync as (...args: unknown[]) => unknown[];
  const readdirSync = ((...args: unknown[]) => {
    const names = listed(...args);
    return renamedAway.directory && String(args[0]) === renamedAway.directory ? [...names, renamedAway.name] : names;
  }) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, readdirSync }, readdirSync };
});

const folders: string[] = [];
afterEach(() => {
  renamedAway.directory = "";
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspaceWithAWriteInFlight(): string {
  const root = mkdtempSync(join(tmpdir(), "laterdog-vanishing-"));
  folders.push(root);
  writeFileSync(join(root, "bots.json"), JSON.stringify([{ id: "dog" }]));
  renamedAway.directory = realpathSync(root);
  renamedAway.name = "account-snapshots.json.4242.0f0e2b1c-1111-4222-8333-944445555666.tmp";
  return root;
}

it("backs up a workspace whose app renames a file away while the backup lists the folder", async () => {
  const root = workspaceWithAWriteInFlight();
  const created = await createWorkspaceBackupSnapshot(root, { password: "fixture password 123", appVersion: "0.1.90" });
  expect(created.summary.files).toBe(1);
  expect(created.summary.bots).toBe(1);
});

it("measures a move without the file that was renamed away", () => {
  const root = workspaceWithAWriteInFlight();
  renamedAway.directory = root;
  expect(workspaceMoveSize(root)).toEqual({ bytes: JSON.stringify([{ id: "dog" }]).length, files: 1 });
});
