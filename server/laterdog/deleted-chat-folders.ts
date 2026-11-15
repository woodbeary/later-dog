import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sizeOf } from "./janitor.ts";

export const DELETED_CHAT_FOLDERS = "deleted-chat-folders";
export const DELETED_FOLDER_KEEP_MS = 7 * 24 * 60 * 60_000;
export const DELETED_SWEEP_EVERY_MS = 60 * 60_000;
export const STORED_AWAY_MARKER = ".laterdog-away.json";
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ASIDE_NAME = /^([A-Za-z0-9_-]{1,128})-(\d{1,16})$/;

function names(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export function setAsideChatFolders(threadId: string, workspaces: string, aside: string, now = Date.now()): string[] {
  if (!SAFE_ID.test(threadId)) return [];
  const moved: string[] = [];
  for (const dog of names(workspaces)) {
    if (!SAFE_ID.test(dog)) continue;
    const from = join(workspaces, dog, threadId);
    const to = join(aside, dog, `${threadId}-${now}`);
    if (existsSync(join(from, STORED_AWAY_MARKER))) continue;
    try {
      mkdirSync(join(aside, dog), { recursive: true, mode: 0o700 });
      renameSync(from, to);
      moved.push(to);
    } catch {
      continue;
    }
    try { rmdirSync(join(workspaces, dog)); } catch {}
  }
  return moved;
}

export function removeDeletedChatFolders(aside: string, now = Date.now(), keepMs = DELETED_FOLDER_KEEP_MS): { removed: string[]; freed: number } {
  const removed: string[] = [];
  let freed = 0;
  for (const dog of names(aside)) {
    const dir = join(aside, dog);
    for (const name of names(dir)) {
      const at = Number(ASIDE_NAME.exec(name)?.[2]);
      if (!Number.isFinite(at) || now - at < keepMs) continue;
      const path = join(dir, name);
      const bytes = sizeOf(path);
      try {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
        freed += bytes;
      } catch {}
    }
    try { rmdirSync(dir); } catch {}
  }
  return { removed, freed };
}

export interface DeletedChatFolderDeps {
  changes(listener: (change: { type: string; threadId?: string }) => void): void;
  workspaces: string;
  aside: string;
  log?: (line: string) => void;
  everyMs?: number;
}

export function startDeletedChatFolders(deps: DeletedChatFolderDeps): () => void {
  const log = deps.log ?? ((line: string) => console.log(line));
  deps.changes((change) => {
    if (change.type !== "thread.deleted" || !change.threadId) return;
    const moved = setAsideChatFolders(change.threadId, deps.workspaces, deps.aside);
    if (moved.length) log(`laterdog home: chat ${change.threadId.slice(0, 8)} was deleted; its work folder is kept 7 days, then removed`);
  });
  const sweep = () => {
    const done = removeDeletedChatFolders(deps.aside);
    if (done.removed.length) log(`laterdog home: removed the work folders of ${done.removed.length} chat(s) deleted over 7 days ago, freed ${Math.round(done.freed / 1024 ** 2)} MB`);
  };
  sweep();
  const timer = setInterval(sweep, deps.everyMs ?? DELETED_SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
