import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { MOUNTED_FOLDER_ANSWER_MS, MountedFolderStalled, type FolderWait, type createMountedFolderGate } from "./mounted-folder-gate.ts";

type Gate = Pick<ReturnType<typeof createMountedFolderGate>, "wait">;

export interface TurnFolders {
  workspace: string;
  task?: string;
  budgetMs: number;
  gate: Gate;
  active: boolean;
  onWait?: (wait: FolderWait) => void;
  makeDir?: (path: string) => Promise<unknown>;
  noticeMs?: number;
  now?: () => number;
}

export async function prepareTurnFolders(input: TurnFolders): Promise<void> {
  if (!input.active) return;
  const now = input.now ?? Date.now;
  const began = now();
  const deadline = began + input.budgetMs;
  const make = input.makeDir ?? ((path: string) => mkdir(path, { recursive: true, mode: 0o700 }));
  let announced = false;
  const notice = setTimeout(() => { announced = true; input.onWait?.({ waiting: true }); }, input.noticeMs ?? MOUNTED_FOLDER_ANSWER_MS);
  const within = async (path: string, work: () => Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - now())); });
    const done = await Promise.race([work().then(() => true as const), late]);
    clearTimeout(timer);
    if (!done) throw new MountedFolderStalled(path);
  };
  let opened = false;
  try {
    await input.gate.wait(input.workspace, Math.max(0, deadline - now()));
    await within(input.workspace, () => make(join(input.workspace, "memory")));
    if (input.task) await within(input.task, () => make(input.task!));
    opened = true;
  } finally {
    clearTimeout(notice);
    if (announced) input.onWait?.({ waiting: false, opened, waitedMs: Math.max(0, now() - began) });
  }
}
