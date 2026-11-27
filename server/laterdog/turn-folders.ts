import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MOUNTED_FOLDER_ANSWER_MS, MountedFolderStalled, type FolderWait, type createMountedFolderGate } from "./mounted-folder-gate.ts";

type Gate = Pick<ReturnType<typeof createMountedFolderGate>, "wait">;

export interface TurnFolders {
  workspace: string;
  task?: string;
  seed?: { name: string; text: string };
  budgetMs: number;
  gate: Gate;
  active: boolean;
  onWait?: (wait: FolderWait) => void;
  makeDir?: (path: string) => Promise<unknown>;
  writeNew?: (path: string, text: string) => Promise<unknown>;
  noticeMs?: number;
  retryMs?: number;
  now?: () => number;
}

const STILL_OPENING = new Set(["ETIMEDOUT", "EAGAIN", "EBUSY"]);

async function writeNew(path: string, text: string): Promise<void> {
  try { await writeFile(path, text, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

export async function prepareTurnFolders(input: TurnFolders): Promise<void> {
  if (!input.active) return;
  const now = input.now ?? Date.now;
  const began = now();
  const deadline = began + input.budgetMs;
  const retryMs = input.retryMs ?? 3_000;
  const make = input.makeDir ?? ((path: string) => mkdir(path, { recursive: true, mode: 0o700 }));
  let announced = false;
  const notice = setTimeout(() => { announced = true; input.onWait?.({ waiting: true }); }, input.noticeMs ?? MOUNTED_FOLDER_ANSWER_MS);
  const within = async (path: string, work: () => Promise<unknown>) => {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - now())); });
      try {
        const done = await Promise.race([work().then(() => true as const), late]);
        if (!done) throw new MountedFolderStalled(path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (error instanceof MountedFolderStalled || !STILL_OPENING.has(code ?? "") || deadline - now() <= retryMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      } finally {
        clearTimeout(timer);
      }
    }
  };
  let opened = false;
  try {
    await input.gate.wait(input.workspace, Math.max(0, deadline - now()));
    await within(input.workspace, () => make(join(input.workspace, "memory")));
    if (input.seed) {
      const seed = input.seed;
      await within(input.workspace, () => (input.writeNew ?? writeNew)(join(input.workspace, seed.name), seed.text));
    }
    if (input.task) await within(input.task, () => make(input.task!));
    opened = true;
  } finally {
    clearTimeout(notice);
    if (announced) input.onWait?.({ waiting: false, opened, waitedMs: Math.max(0, now() - began) });
  }
}
