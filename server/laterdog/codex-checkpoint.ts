import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { renameWithRetry, writeFileAtomic } from "../atomic.ts";
import { engineFilePath, type EngineFileRoot } from "./engine-files.ts";
import { findSelectedCodexRollout, inspectCodexRollout, validatedCodexRollout } from "./codex-rollout.ts";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export function codexPendingDispatch(dataDir: string, botId: string, threadId: string, turnId: string, sourceMessageId?: string) {
  const file = join(dataDir, "engine-checkpoints", digest(JSON.stringify([botId, threadId])) + ".pending");
  return {
    has: () => existsSync(file),
    sameSource() {
      if (!sourceMessageId || !existsSync(file)) return false;
      const raw = readFileSync(file, "utf8");
      return raw.startsWith("{") && JSON.parse(raw).source === sourceMessageId;
    },
    start() {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileAtomic(file, JSON.stringify({ turnId, source: sourceMessageId }), { mode: 0o600 });
    },
    clear() {
      try {
        const raw = readFileSync(file, "utf8");
        if ((raw.startsWith("{") ? JSON.parse(raw).turnId : raw) === turnId) unlinkSync(file);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    },
  };
}

export class ChangedCodexCheckpoint extends Error {}

export function codexCheckpoint(dataDir: string, accountHome: string, bot: string, thread: string, instance: string, account: string) {
  const key = digest(JSON.stringify([bot, thread, instance, account]));
  const receipt = (cursor: string) => join(dataDir, "engine-checkpoints", digest(cursor) + ".json");
  const sessions: EngineFileRoot = { id: "sessions", path: join(accountHome, "sessions"), writable: true };
  const requireOwner = (cursor: string) => {
    const file = receipt(cursor);
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).owner !== key) throw new Error("The native Codex checkpoint is bound to another dog, chat or account.");
  };
  const remember = (cursor: string, path: string, hash: string) => {
    requireOwner(cursor);
    const file = receipt(cursor);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify({ owner: key, cursor, path, hash }), { mode: 0o600 });
  };
  const lookup = async (cursor: string) => {
    const file = receipt(cursor);
    if (!existsSync(file)) return null;
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.cursor !== cursor || saved.owner !== key) throw new Error("The native Codex checkpoint is bound to another dog, chat or account.");
    const current = await inspectCodexRollout(sessions, saved.path, cursor);
    if (saved.hash !== current.hash) throw new ChangedCodexCheckpoint("The native Codex checkpoint has changed since this chat saved it.");
    return { path: String(saved.path), ...current };
  };
  return {
    key, lookup,
    async bindSaved(cursor: string, workspace: string) {
      const saved = await lookup(cursor);
      if (saved) return saved;
      const name = await findSelectedCodexRollout(sessions, cursor);
      const verified = await inspectCodexRollout(sessions, name, cursor, undefined, undefined, workspace);
      remember(cursor, name, verified.hash);
      return { path: name, ...verified };
    },
    async rememberHome(cursor: string, nativePath: string) {
      const name = relative(sessions.path, nativePath);
      remember(cursor, name, (await inspectCodexRollout(sessions, name, cursor)).hash);
    },
    async stage(cursor: string, privateSessions: string, bound: { path: string; hash: string }) {
      const target = engineFilePath({ ...sessions, path: privateSessions }, validatedCodexRollout(bound.path, cursor));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = await open(target, constants.O_WRONLY | constants.O_EXCL | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if ((await inspectCodexRollout(sessions, bound.path, cursor, fd)).hash !== bound.hash) throw new ChangedCodexCheckpoint("The native Codex checkpoint changed before staging.");
      } finally { await fd.close(); }
    },
    async publish(cursor: string, privateSessions: string, name: string, previous: { path: string; hash: string } | null, turnId: string) {
      const target = engineFilePath(sessions, validatedCodexRollout(name, cursor));
      if (previous && previous.path !== name) throw new Error("The native Codex checkpoint no longer matches its selected path.");
      requireOwner(cursor);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const temp = target + "." + randomUUID() + ".tmp";
      const fd = await open(temp, constants.O_WRONLY | constants.O_EXCL | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        let hash: string;
        try {
          hash = (await inspectCodexRollout({ ...sessions, path: privateSessions }, name, cursor, fd, turnId)).hash;
          await fd.sync();
        } finally { await fd.close(); }
        const verified = existsSync(target) ? await inspectCodexRollout(sessions, name, cursor) : null;
        const current = verified?.hash ?? null;
        requireOwner(cursor);
        const installed = lstatSync(engineFilePath(sessions, name), { throwIfNoEntry: false });
        if (verified ? !installed || installed.dev !== verified.identity.dev || installed.ino !== verified.identity.ino ||
          installed.size !== verified.size || installed.ctimeMs !== verified.identity.ctimeMs || installed.mtimeMs !== verified.identity.mtimeMs : installed) {
          throw new Error("A newer home checkpoint already exists for this Codex chat.");
        }
        if (current !== hash) {
          if (current !== (previous?.hash ?? null)) throw new Error("A newer home checkpoint already exists for this Codex chat.");
          renameWithRetry(temp, target);
        }
        remember(cursor, name, hash);
      } finally {
        rmSync(temp, { force: true });
      }
    },
  };
}
