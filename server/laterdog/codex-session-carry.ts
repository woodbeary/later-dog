import { copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CODEX_UUID, findSelectedCodexRollout, MissingCodexSession } from "./codex-rollout.ts";
import type { CarriedSession } from "./session-carry.ts";

const isFolder = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() === true;

export async function carryCodexSession(input: { cursor: unknown; fromHome: string; toHome: string }): Promise<CarriedSession | undefined> {
  const { cursor, fromHome, toHome } = input;
  if (typeof cursor !== "string" || !CODEX_UUID.test(cursor) || fromHome === toHome) return undefined;
  const sessions = join(fromHome, "sessions");
  if (!await isFolder(sessions)) return undefined;
  let name: string;
  try {
    name = await findSelectedCodexRollout({ id: "sessions", path: sessions, writable: false }, cursor);
  } catch (error) {
    if (error instanceof MissingCodexSession) return undefined;
    throw error;
  }
  const from = join(sessions, name);
  const to = join(toHome, "sessions", name);
  const there = await lstat(to).catch(() => null);
  if (there?.isSymbolicLink()) return undefined;
  if (!(await lstat(from)).isFile()) return undefined;
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  await copyFile(from, to);
  return { sessionId: cursor, copied: [join("sessions", name)] };
}
