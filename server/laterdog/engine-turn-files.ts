import { relative, resolve, sep } from "node:path";
import * as local from "../checkpoints.ts";
import { guestFolderDir } from "./engine-folder-sync.ts";

export type GuestCheckpoint = { op: "take" | "diff" | "release"; botId: string; root: string; cwd: string; value: string; label?: string };
const gitHash = /^[a-f0-9]{40}$/;

export function runGuestCheckpoint(request: GuestCheckpoint): Promise<string | local.CheckpointDiff | null | void> {
  guestFolderDir(request.root);
  const tail = relative(request.root, request.cwd);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.botId) || request.cwd !== resolve(request.cwd) ||
      tail === ".." || tail.startsWith(".." + sep) || request.value.length > 256) throw new Error("Invalid working folder checkpoint");
  if (request.op === "take") return local.snapshot(request.botId, request.cwd, request.label ?? "turn", undefined, { pin: request.value, sharedPins: true });
  if (request.op === "diff" && gitHash.test(request.value)) return local.diffWorkingTree(request.botId, request.cwd, request.value, undefined, true);
  if (request.op === "release") return local.release(request.botId, request.cwd, request.value);
  throw new Error("Invalid working folder checkpoint operation");
}

