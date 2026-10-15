import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceMoveSize } from "../cloud-move.ts";
import { tidyCloudMoveStorage } from "../cloud-move.ts";
import { applyPendingWorkspaceRestore, commitPendingWorkspaceRestore, createWorkspaceBackup, readLastWorkspaceRestore, stageWorkspaceBackup } from "../workspace-backup.ts";
import { clearReceivedMove, noteReceivedMovePending, readReceivedMove } from "./cloud-move-received.ts";
import { CLOUD_MOVE_LEFT_BEHIND, leftBehindByProfile, measureLeftOnComputer } from "./cloud-move-profile.ts";

const PASSWORD = "correct horse battery staple";
const scratch: string[] = [];
const directory = () => { const path = mkdtempSync(join(tmpdir(), "laterdog-cloud-move-profile-")); scratch.push(path); return path; };
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
afterEach(() => { for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true }); });

function macWorkspace(): string {
  const root = directory();
  for (const [name, size] of [["task-workspaces", 4000], ["native", 3000], ["tool-results", 2000], ["providers", 1000]] as const) {
    mkdirSync(join(root, name, "nested"), { recursive: true });
    writeFileSync(join(root, name, "nested", "big.bin"), Buffer.alloc(size, 1));
  }
  mkdirSync(join(root, "attachments"));
  writeFileSync(join(root, "attachments", "note.txt"), "kept");
  json(join(root, "bots.json"), [{ id: "starter" }, { id: "desk" }]);
  json(join(root, "groups.json"), []);
  json(join(root, "routines.json"), { version: 1, routines: [{ id: "nightly", enabled: true }, { id: "off", enabled: false }, { id: "weekly", enabled: true }], runs: [{ id: "q", status: "queued" }] });
  const db = new DatabaseSync(join(root, "messages.db"));
  db.exec("CREATE TABLE messages(thread_id TEXT, id TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY, active_leaf_id TEXT);");
  db.close();
  return root;
}

async function moveTo(target: string, source: string, profile?: "cloud-move") {
  const exported = await createWorkspaceBackup(source, { password: PASSWORD, appVersion: "1.0.0", ...(profile ? { profile } : {}) });
  const staged = await stageWorkspaceBackup(target, exported.path, { password: PASSWORD, currentAppVersion: "1.0.0" });
  commitPendingWorkspaceRestore(target, staged.id);
  applyPendingWorkspaceRestore(target);
  return { exported, staged };
}

describe("the cloud-move export profile", () => {
  it("leaves out task-workspaces, native, tool-results and providers, keeps the rest, and reports what stayed with its bytes", async () => {
    const source = macWorkspace();
    const target = directory();
    json(join(target, "bots.json"), [{ id: "ember" }]);
    const { exported } = await moveTo(target, source, "cloud-move");
    for (const name of CLOUD_MOVE_LEFT_BEHIND) expect(existsSync(join(target, name))).toBe(false);
    expect(readFileSync(join(target, "attachments", "note.txt"), "utf8")).toBe("kept");
    expect(readJson(join(target, "bots.json"))).toEqual([{ id: "starter" }, { id: "desk" }]);
    expect(exported.summary.profile).toBe("cloud-move");
    expect(exported.summary.leftOnComputer).toEqual([
      { name: "task-workspaces", bytes: 4000 }, { name: "native", bytes: 3000 }, { name: "tool-results", bytes: 2000 }, { name: "providers", bytes: 1000 },
    ]);
    expect(existsSync(join(source, "task-workspaces", "nested", "big.bin"))).toBe(true);
  });

  it("without the profile the full workspace travels and nothing is reported as left behind", async () => {
    const source = macWorkspace();
    const target = directory();
    const { exported } = await moveTo(target, source);
    for (const name of ["task-workspaces", "native", "tool-results"]) expect(existsSync(join(target, name, "nested", "big.bin"))).toBe(true);
    expect(existsSync(join(target, "providers"))).toBe(false);
    expect(exported.summary.profile).toBeUndefined();
    expect(exported.summary.leftOnComputer).toBeUndefined();
  });

  it("the estimate for the profile counts only what will travel", () => {
    const source = macWorkspace();
    const full = workspaceMoveSize(source);
    const slim = workspaceMoveSize(source, "cloud-move");
    expect(full.bytes - slim.bytes).toBe(9000);
    expect(leftBehindByProfile("native", "cloud-move")).toBe(true);
    expect(leftBehindByProfile("native")).toBe(false);
    expect(leftBehindByProfile("attachments", "cloud-move")).toBe(false);
    expect(measureLeftOnComputer(source)).toEqual([]);
  });

  it("restoring a cloud-move upload turns on exactly the routines that were enabled on the Mac", async () => {
    const source = macWorkspace();
    const target = directory();
    await moveTo(target, source, "cloud-move");
    const restored = readJson(join(target, "routines.json"));
    expect(Object.fromEntries(restored.routines.map((routine: { id: string; enabled: boolean }) => [routine.id, routine.enabled]))).toEqual({ nightly: true, off: false, weekly: true });
    expect(restored.runs[0].status).toBe("failed");
  });

  it("restoring an ordinary backup still pauses every routine", async () => {
    const source = macWorkspace();
    const target = directory();
    await moveTo(target, source);
    expect(readJson(join(target, "routines.json")).routines.map((routine: { enabled: boolean }) => routine.enabled)).toEqual([false, false, false]);
  });
});

describe("the home's record of a received move", () => {
  it("is settled only once the restore it belongs to has completed, and an undo clears it", () => {
    const home = directory();
    mkdirSync(join(home, ".backups"));
    const id = "3f9c2a4e-8b1d-4c6e-9a7f-0123456789ab";
    noteReceivedMovePending(home, id, "mac-env-1", 5);
    expect(readReceivedMove(home)).toBeNull();
    tidyCloudMoveStorage(home, { id: "other", restored: true });
    expect(readReceivedMove(home)).toBeNull();
    noteReceivedMovePending(home, id, "mac-env-1", 5);
    tidyCloudMoveStorage(home, { id, restored: true });
    expect(readReceivedMove(home)).toEqual({ environmentId: "mac-env-1", at: 5 });
    clearReceivedMove(home);
    expect(readReceivedMove(home)).toBeNull();
  });

  it("is dropped when the restore rolled back", () => {
    const home = directory();
    mkdirSync(join(home, ".backups"));
    const id = "3f9c2a4e-8b1d-4c6e-9a7f-0123456789ab";
    noteReceivedMovePending(home, id, "mac-env-1", 5);
    tidyCloudMoveStorage(home, { id, restored: false, rolledBack: true });
    expect(readReceivedMove(home)).toBeNull();
    expect(readLastWorkspaceRestore(home)).toBeNull();
  });
});
