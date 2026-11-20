import { cpSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectSlug } from "./engine-placement.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CarriedSession {
  sessionId: string;
  copied: string[];
}

function plainEntry(path: string): "file" | "folder" | undefined {
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return undefined;
    return info.isFile() ? "file" : info.isDirectory() ? "folder" : undefined;
  } catch {
    return undefined;
  }
}

export function carryClaudeSession(input: { sessionId: unknown; cwd: string; fromConfigDir: string; toConfigDir: string }): CarriedSession | undefined {
  const { sessionId, cwd, fromConfigDir, toConfigDir } = input;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || fromConfigDir === toConfigDir) return undefined;
  const slug = claudeProjectSlug(cwd);
  const transcript = join("projects", slug, `${sessionId}.jsonl`);
  if (plainEntry(join(fromConfigDir, transcript)) !== "file") return undefined;
  const copied: string[] = [];
  for (const piece of [transcript, join("projects", slug, sessionId), join("file-history", sessionId)]) {
    const from = join(fromConfigDir, piece);
    if (!plainEntry(from)) continue;
    const to = join(toConfigDir, piece);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true, filter: (source) => plainEntry(source) !== undefined });
    copied.push(piece);
  }
  return { sessionId, copied };
}
