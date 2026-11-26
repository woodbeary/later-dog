import { cpSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeProjectSlug, claudeSessionWorkspace } from "./claude-project.ts";

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
  if (typeof sessionId !== "string" || fromConfigDir === toConfigDir) return undefined;
  const { physical, source } = claudeSessionWorkspace(cwd, fromConfigDir, sessionId);
  if (!source) return undefined;
  const project = join("projects", claudeProjectSlug(physical));
  const sourceProject = join("projects", claudeProjectSlug(source));
  for (const folder of ["projects", project, "file-history"]) {
    const entry = lstatSync(join(toConfigDir, folder), { throwIfNoEntry: false });
    if (entry && !entry.isDirectory()) return undefined;
  }
  const copied: string[] = [];
  for (const [fromPiece, piece] of [
    [join(sourceProject, `${sessionId}.jsonl`), join(project, `${sessionId}.jsonl`)],
    [join(sourceProject, sessionId), join(project, sessionId)],
    [join("file-history", sessionId), join("file-history", sessionId)],
  ] as const) {
    const from = join(fromConfigDir, fromPiece);
    if (plainEntry(dirname(from)) !== "folder" || !plainEntry(from)) continue;
    const to = join(toConfigDir, piece);
    if (lstatSync(to, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined;
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true, filter: (source, destination) => plainEntry(source) !== undefined && !lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink() });
    copied.push(piece);
  }
  return { sessionId, copied };
}
