import type { GuestCheckpoint } from "./engine-turn-files.ts";
import { stripVTControlCharacters } from "node:util";
import { engineComputer, jobComputer } from "../computers.ts";
import * as local from "../checkpoints.ts";
import { GUEST_FOLDER_HELPER } from "./engine-folder-process.ts";
import { guestFolderDir } from "./engine-folder-sync.ts";
import type { managedJobFolders } from "./managed-job-folders.ts";
import type { RunBox } from "./computer-runs.ts";

type FolderAccess = NonNullable<ReturnType<typeof managedJobFolders>>;
const gitHash = /^[a-f0-9]{40}$/;
const machineHash = /^(cmp_[A-Za-z0-9_-]+)\.([a-f0-9]{40})$/;

async function call(box: RunBox, request: GuestCheckpoint) {
  const encoded = Buffer.from(JSON.stringify(request)).toString("base64url");
  const path = guestFolderDir(request.root) + "/turn-files.lock";
  const result = await box.exec("LATERDOG_HOME=/home/dog/.laterdog-engine/turn-file-history flock -w 125 '" + path +
    "' node '" + GUEST_FOLDER_HELPER + "' turn-files " + encoded, 150_000);
  if (result.exitCode !== 0) throw new Error("The assigned computer could not check its working folder changes");
  const line = stripVTControlCharacters(result.stdout).trim().split("\n").at(-1);
  if (!line) throw new Error("Missing working folder change receipt");
  return JSON.parse(line).result;
}

export function turnFileCheckpoints(folders: FolderAccess | null) {
  if (!folders) return local;
  const active = new Map<string, string>();
  function pinKey(botId: string, pin: string) { return botId + "/" + pin; }
  return {
    async snapshot(botId: string, cwd: string, label: string, signal?: AbortSignal, opts?: { pin?: string }): Promise<string | null> {
      const scope = folders.resolve(botId, cwd);
      if (!scope || !opts?.pin) return null;
      try {
        const machine = await engineComputer(botId, signal);
        const box = { ...machine.box, stream: machine.stream };
        if (!box.computerId) return null;
        await folders.sync(box, botId, scope, "hydrate");
        const hash = await call(box, { op: "take", botId, cwd: folders.path(botId, cwd), root: scope.path, value: opts.pin, label });
        if (typeof hash !== "string" || !gitHash.test(hash)) return null;
        active.set(pinKey(botId, opts.pin), box.computerId);
        return box.computerId + "." + hash;
      } catch {
        console.warn("The assigned computer could not capture the turn's initial file list");
        return null;
      }
    },
    async diffWorkingTree(botId: string, cwd: string, hash: string, signal?: AbortSignal): Promise<local.CheckpointDiff | null> {
      const match = machineHash.exec(hash), scope = folders.resolve(botId, cwd);
      if (!match || !scope || signal?.aborted) return null;
      const guest = await jobComputer(botId);
      if (guest.state !== "running" || guest.box.computerId !== match[1] || signal?.aborted) return null;
      const diff = await call(guest.box, { op: "diff", botId, cwd: folders.path(botId, cwd), root: scope.path, value: match[2]! });
      if (!diff || ![diff.added, diff.changed, diff.deleted].every(list => Array.isArray(list) && list.every(name => typeof name === "string"))) return null;
      return diff as local.CheckpointDiff;
    },
    async release(botId: string, cwd: string, pin: string): Promise<void> {
      const key = pinKey(botId, pin), expected = active.get(key), scope = folders.resolve(botId, cwd);
      active.delete(key);
      if (!expected || !scope) return;
      try {
        const guest = await jobComputer(botId);
        if (guest.state === "running" && guest.box.computerId === expected) await call(guest.box, { op: "release", botId, cwd: folders.path(botId, cwd), root: scope.path, value: pin });
      } catch { console.warn("The working folder checkpoint pin remains on the assigned computer"); }
    },
  };
}
