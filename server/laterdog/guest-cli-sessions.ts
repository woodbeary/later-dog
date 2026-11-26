import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import type { SendTurnInput } from "../contracts.ts";
import { userHome } from "../env-path.ts";

const nativeId = /^[a-z0-9_-]{1,128}$/i;

async function exists(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function copyNativeTree(source: string, target: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("The selected engine session contains a symbolic link.");
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) await copyNativeTree(join(source, entry), join(target, entry));
  } else if (info.isFile()) {
    await cp(source, target, { force: false, errorOnExist: true });
    const after = await lstat(source);
    if (after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("The selected engine session is still changing.");
  } else throw new Error("The selected engine session contains an unsupported file.");
}

export async function guestCliSessions(kind: string, instance: string, env: Record<string, string>, turn: SendTurnInput, dataDir = DATA_DIR) {
  const key = createHash("sha256").update(JSON.stringify([kind, instance, turn.botId, turn.threadId])).digest("hex");
  const directory = join(dataDir, "guest-cli-sessions", key);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!turn.resumeCursor || turn.sessionReset || (kind !== "grokAgent" && kind !== "cursorAgent")) return directory;
  if (typeof turn.resumeCursor !== "string" || !nativeId.test(turn.resumeCursor) || !turn.cwd || !isAbsolute(turn.cwd)) throw new Error("The selected engine session cannot be identified.");
  const cwd = await realpath(turn.cwd);
  const folder = (value: string) => kind === "grokAgent" ? encodeURIComponent(value) : createHash("md5").update(value).digest("hex");
  const target = join(directory, folder(cwd), turn.resumeCursor);
  if ((await exists(target))?.isDirectory()) return directory;
  const home = userHome(env);
  const base = kind === "grokAgent" ? join(env.GROK_HOME || join(home, ".grok"), "sessions")
    : join(env.CURSOR_CONFIG_DIR || (env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "cursor") : join(home, ".cursor")), "chats");
  for (const name of new Set([cwd, resolve(turn.cwd)])) {
    const source = join(base, folder(name), turn.resumeCursor);
    const info = await exists(source);
    if (!info) continue;
    if (!info.isDirectory() || await realpath(source) !== join(await realpath(base), folder(name), turn.resumeCursor)) throw new Error("The selected native session has an unexpected location.");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(dirname(target), ".import-"));
    try {
      if (kind === "grokAgent") await copyNativeTree(source, staging);
      else {
        const path = join(source, "store.db");
        if (!(await lstat(path)).isFile()) throw new Error("Cursor's selected chat database is unavailable.");
        const db = new DatabaseSync(path, { readOnly: true });
        try { await backup(db, join(staging, "store.db")); } finally { db.close(); }
      }
      try { await rename(staging, target); } catch (error) {
        if (!["ENOTEMPTY", "EEXIST"].includes(String((error as NodeJS.ErrnoException).code))) throw error;
      }
      return directory;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  throw new Error("The selected native session could not be restored to this dog's computer.");
}
