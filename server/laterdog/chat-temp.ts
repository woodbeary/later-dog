import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sizeOf } from "./janitor.ts";

export const CHAT_TEMP_FOLDER = "laterdog-chats";

export function chatTempRoot(base = tmpdir()): string {
  return join(base, CHAT_TEMP_FOLDER);
}

export function chatTempName(threadId: string): string {
  return threadId.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_") || "_";
}

export function chatTempDir(root: string, threadId: string): string {
  return join(root, chatTempName(threadId));
}

export function prepareChatTemp(root: string, threadId: string): Record<string, string> {
  const dir = chatTempDir(root, threadId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return {};
  }
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

export type InUse = (path: string) => boolean;

export function usedBy(paths: readonly string[], argvs: readonly string[]): InUse {
  return (path) => paths.some((used) => used === path || used.startsWith(`${path}/`)) || argvs.some((argv) => argv.includes(path));
}

function entries(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export interface TempCleared {
  removed: string[];
  freed: number;
}

export function emptyChatTemp(dir: string, inUse: InUse): TempCleared {
  const removed: string[] = [];
  let freed = 0;
  for (const name of entries(dir)) {
    const path = join(dir, name);
    if (inUse(path)) continue;
    const bytes = sizeOf(path);
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
      freed += bytes;
    } catch {}
  }
  return { removed, freed };
}

export interface ChatTempSweep {
  atWork(name: string): boolean;
  engineAlive(name: string): boolean;
  inUse: InUse;
}

export function tidyChatTemp(root: string, name: string, deps: ChatTempSweep): TempCleared {
  const dir = join(root, name);
  try { if (!lstatSync(dir).isDirectory()) return { removed: [], freed: 0 }; } catch { return { removed: [], freed: 0 }; }
  if (deps.atWork(name)) return { removed: [], freed: 0 };
  const cleared = emptyChatTemp(dir, deps.inUse);
  if (deps.engineAlive(name) || deps.inUse(dir) || entries(dir).length) return cleared;
  try {
    rmSync(dir, { recursive: true, force: true });
    return { removed: [...cleared.removed, dir], freed: cleared.freed };
  } catch {
    return cleared;
  }
}

export function sweepChatTemps(root: string, deps: ChatTempSweep): TempCleared {
  const removed: string[] = [];
  let freed = 0;
  for (const name of entries(root)) {
    const cleared = tidyChatTemp(root, name, deps);
    removed.push(...cleared.removed);
    freed += cleared.freed;
  }
  return { removed, freed };
}
