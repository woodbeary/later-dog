import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import { engineFilePath, readEngineFile, type EngineFileRoot } from "./engine-files.ts";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ROLLOUT = /^(\d{4}\/\d{2}\/\d{2}\/rollout-[a-zA-Z0-9_.-]+)-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/;

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
  const inspect = (root: EngineFileRoot, name: string, cursor: string) => {
    if (!UUID.test(cursor) || ROLLOUT.exec(name)?.[2] !== cursor) throw new Error("Codex returned an unexpected checkpoint path.");
    const bytes = readEngineFile(root, name);
    const newline = bytes.indexOf(10);
    if (newline < 1 || newline > 1024 * 1024) throw new Error("The native Codex checkpoint is incomplete.");
    const first = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
    if (first.type !== "session_meta" || first.payload?.id !== cursor) throw new Error("The native Codex checkpoint belongs to another session.");
    return { bytes, hash: digest(bytes) };
  };
  const remember = (cursor: string, path: string, hash: string) => {
    const file = receipt(cursor);
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).owner !== key) throw new Error("The native Codex checkpoint is bound to another dog, chat or account.");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify({ owner: key, cursor, path, hash }), { mode: 0o600 });
  };
  const lookup = (cursor: string) => {
    const file = receipt(cursor);
    if (!existsSync(file)) return null;
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (saved.cursor !== cursor || saved.owner !== key) throw new Error("The native Codex checkpoint is bound to another dog, chat or account.");
    const current = inspect(sessions, saved.path, cursor);
    if (saved.hash !== current.hash) throw new ChangedCodexCheckpoint("The native Codex checkpoint has changed since this chat saved it.");
    return { path: String(saved.path), ...current };
  };
  return {
    key, lookup,
    rememberHome(cursor: string, nativePath: string) {
      const name = relative(sessions.path, nativePath);
      remember(cursor, name, inspect(sessions, name, cursor).hash);
    },
    publish(cursor: string, privateSessions: string, name: string, previous: { path: string; hash: string } | null, turnId: string) {
      const { bytes, hash } = inspect({ ...sessions, path: privateSessions }, name, cursor);
      const marker = Buffer.from(`"turn_id":"${turnId}"`);
      const completed = () => {
        let offset = bytes.length - 1;
        while (offset >= 0) {
          const hit = bytes.lastIndexOf(marker, offset);
          if (hit < 0) break;
          const start = bytes.lastIndexOf(10, hit) + 1;
          const end = bytes.indexOf(10, hit);
          if (end < 0) { offset = start - 1; continue; }
          const row = JSON.parse(bytes.subarray(start, end).toString("utf8"));
          if (row.type === "event_msg" && row.payload?.type === "task_complete" && row.payload.turn_id === turnId) return true;
          offset = start - 1;
        }
        return false;
      };
      if (!UUID.test(turnId) || !completed()) throw new Error("The native Codex checkpoint omitted the completed turn.");
      const target = engineFilePath(sessions, name);
      const current = existsSync(target) ? inspect(sessions, name, cursor).hash : null;
      if (current !== hash) {
        if (current !== (previous?.hash ?? null) || (previous && previous.path !== name)) throw new Error("A newer home checkpoint already exists for this Codex chat.");
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileAtomic(target, bytes, { mode: 0o600 });
      }
      remember(cursor, name, hash);
    },
  };
}
