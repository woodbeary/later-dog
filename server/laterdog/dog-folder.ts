import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const FOLDER_READ_BYTES = 256 * 1024;
export const FOLDER_WRITE_BYTES = 2 * 1024 * 1024;
export const FOLDER_EDIT_BYTES = 8 * 1024 * 1024;
export const FOLDER_LIST_ENTRIES = 500;
export const FOLDER_SEARCH_FILES = 3_000;
export const FOLDER_SEARCH_FILE_BYTES = 1024 * 1024;
export const FOLDER_SEARCH_MATCHES = 100;
export const FOLDER_SEARCH_MS = 20_000;
const SKIPPED = new Set([".git", "node_modules"]);
const CHANGES = new Set(["write", "edit", "delete"]);
export const FOLDER_NOT_SAVED = "Not saved: your folder is not answering, so nothing was written to it. A file in your scratch folder is not saved to your folder. Tell the person it was not saved, and try again in a minute.";

export type FolderRun = <T>(path: string, op: () => Promise<T>) => Promise<T>;

export interface FolderRequest {
  action?: unknown;
  path?: unknown;
  content?: unknown;
  expected_sha256?: unknown;
  old_text?: unknown;
  new_text?: unknown;
  replace_all?: unknown;
  pattern?: unknown;
  glob?: unknown;
  offset?: unknown;
  length?: unknown;
}

export interface FolderAnswer { status: number; text?: string; error?: string }

class FolderRefusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
const text = (value: unknown) => typeof value === "string" ? value : undefined;

export function folderGlob(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.includes("/") ? `^${out}$` : `(^|/)${out}$`);
}

export async function folderAction(request: FolderRequest, roots: readonly string[], run: FolderRun): Promise<FolderAnswer> {
  try {
    return { status: 200, text: await act(request, roots.map((root) => resolve(root)), run) };
  } catch (error) {
    if (error instanceof FolderRefusal) return { status: error.status, error: `${CHANGES.has(String(request.action)) ? "Not saved: " : ""}${error.message}` };
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EMOUNTDOWN") return { status: 503, error: CHANGES.has(String(request.action)) ? FOLDER_NOT_SAVED : "Your folder is not answering right now, so it could not be read. Try again in a minute." };
    if (code === "ENOENT") return { status: 404, error: "Nothing is at that path in your folder." };
    if (code === "EISDIR") return { status: 400, error: "That path is a folder; use action list." };
    if (code === "ENOTDIR") return { status: 400, error: "That path is a file, not a folder." };
    return { status: 500, error: `${CHANGES.has(String(request.action)) ? "Not saved: nothing was written to your folder. " : ""}The folder could not do that: ${(error as Error).message}` };
  }
}

async function act(request: FolderRequest, roots: string[], run: FolderRun): Promise<string> {
  const working = roots[0];
  if (!working) throw new FolderRefusal(409, "This conversation has no working folder.");
  const action = text(request.action);
  const asked = text(request.path) ?? "";
  const target = place(asked, working, roots);
  const root = roots.find((candidate) => within(candidate, target))!;
  const shown = (path: string) => relative(working, path) || ".";
  await stayInside(target, root, run);
  if (action === "list") return list(target, shown, run);
  if (action === "read") return read(target, shown, request, run);
  if (action === "search") return search(target, shown, request, run);
  if (action === "write") return write(target, shown, request, run);
  if (action === "edit") return edit(target, shown, request, run);
  if (action === "delete") return remove(target, root, shown, run);
  throw new FolderRefusal(400, "Use action list, read, search, write, edit or delete.");
}

function place(asked: string, working: string, roots: string[]): string {
  if (asked.includes("\0")) throw new FolderRefusal(400, "That path is not valid.");
  const target = resolve(working, isAbsolute(asked) ? asked : asked || ".");
  if (!roots.some((root) => within(root, target))) throw new FolderRefusal(403, "That path is outside your folders. Use a path inside your working folder.");
  return target;
}

async function stayInside(target: string, root: string, run: FolderRun): Promise<void> {
  const realRoot = await run(root, () => realpath(root)).catch((error: unknown) => { if (missing(error)) return root; throw error; });
  let probe = target;
  for (;;) {
    const real = await run(probe, () => realpath(probe)).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (real !== null) {
      if (!within(realRoot, real)) throw new FolderRefusal(403, "That path leads outside your folders.");
      return;
    }
    if (probe === root || dirname(probe) === probe) return;
    probe = dirname(probe);
  }
}

async function list(target: string, shown: (path: string) => string, run: FolderRun): Promise<string> {
  const entries = await run(target, () => readdir(target, { withFileTypes: true }));
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = entries.slice(0, FOLDER_LIST_ENTRIES).map((entry: Dirent) => `${entry.isDirectory() ? "dir " : entry.isSymbolicLink() ? "link" : "file"} ${entry.name}`);
  const more = entries.length > FOLDER_LIST_ENTRIES ? `\n… and ${entries.length - FOLDER_LIST_ENTRIES} more` : "";
  return `${shown(target)} (${entries.length} entries)\n${lines.join("\n")}${more}`;
}

async function read(target: string, shown: (path: string) => string, request: FolderRequest, run: FolderRun): Promise<string> {
  const bytes = await run(target, () => readFile(target));
  const offset = Number.isInteger(request.offset) && (request.offset as number) > 0 ? request.offset as number : 0;
  const length = Number.isInteger(request.length) && (request.length as number) > 0 ? Math.min(request.length as number, FOLDER_READ_BYTES) : FOLDER_READ_BYTES;
  const part = bytes.subarray(offset, offset + length);
  if (part.includes(0)) return `${shown(target)} is a binary file (${bytes.length} bytes, sha256 ${sha(bytes)}).`;
  const rest = offset + part.length < bytes.length ? `\n[${bytes.length - offset - part.length} more bytes: read again with offset ${offset + part.length}]` : "";
  return `${shown(target)} · ${bytes.length} bytes · sha256 ${sha(bytes)}\n${part.toString("utf8")}${rest}`;
}

async function search(target: string, shown: (path: string) => string, request: FolderRequest, run: FolderRun): Promise<string> {
  const pattern = text(request.pattern);
  if (!pattern) throw new FolderRefusal(400, "search needs a pattern (a regular expression).");
  let expression: RegExp;
  try { expression = new RegExp(pattern); } catch { throw new FolderRefusal(400, "That pattern is not a valid regular expression."); }
  const glob = text(request.glob);
  const only = glob ? folderGlob(glob) : null;
  const ends = Date.now() + FOLDER_SEARCH_MS;
  const hits: string[] = [];
  let files = 0;
  let cut = "";
  const pending = [target];
  while (pending.length && hits.length < FOLDER_SEARCH_MATCHES) {
    if (Date.now() > ends) { cut = "time"; break; }
    const folder = pending.shift()!;
    const stat = await run(folder, () => lstat(folder));
    if (stat.isFile()) { files++; await scan(folder); continue; }
    if (!stat.isDirectory()) continue;
    const entries = await run(folder, () => readdir(folder, { withFileTypes: true }));
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        if (only && !only.test(relative(target, path))) continue;
        if (++files > FOLDER_SEARCH_FILES) { cut = "files"; break; }
        await scan(path);
        if (hits.length >= FOLDER_SEARCH_MATCHES || Date.now() > ends) break;
      }
    }
    if (cut === "files") break;
  }
  async function scan(path: string) {
    const stat: Stats = await run(path, () => lstat(path));
    if (stat.size > FOLDER_SEARCH_FILE_BYTES) return;
    const bytes = await run(path, () => readFile(path));
    if (bytes.includes(0)) return;
    const lines = bytes.toString("utf8").split("\n");
    for (let i = 0; i < lines.length && hits.length < FOLDER_SEARCH_MATCHES; i++) {
      if (expression.test(lines[i]!)) hits.push(`${shown(path)}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
    }
  }
  const note = hits.length >= FOLDER_SEARCH_MATCHES ? `\n[stopped at ${FOLDER_SEARCH_MATCHES} matches]`
    : cut === "time" ? "\n[stopped after 20 s; search a smaller folder]"
      : cut === "files" ? `\n[stopped after ${FOLDER_SEARCH_FILES} files; search a smaller folder or pass glob]` : "";
  return hits.length ? `${hits.join("\n")}${note}` : `No matches.${note}`;
}

async function current(target: string, run: FolderRun): Promise<Buffer | null> {
  return run(target, () => readFile(target)).catch((error: unknown) => { if (missing(error)) return null; throw error; });
}

async function save(target: string, data: string, run: FolderRun): Promise<void> {
  await run(target, async () => {
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, target).catch(async (error: unknown) => { await unlink(temporary).catch(() => {}); throw error; });
  });
}

async function write(target: string, shown: (path: string) => string, request: FolderRequest, run: FolderRun): Promise<string> {
  const content = text(request.content);
  if (content === undefined) throw new FolderRefusal(400, "write needs content.");
  if (Buffer.byteLength(content) > FOLDER_WRITE_BYTES) throw new FolderRefusal(413, "That is over 2 MiB; write it in a helper on your computer instead (run_on_computer).");
  const before = await current(target, run);
  const expected = text(request.expected_sha256);
  if (before && expected !== sha(before)) {
    throw new FolderRefusal(409, `${shown(target)} already exists (sha256 ${sha(before)}). Read it, then pass that expected_sha256 to overwrite, or use edit.`);
  }
  await save(target, content, run);
  return `${before ? "Replaced" : "Created"} ${shown(target)} (${Buffer.byteLength(content)} bytes, sha256 ${sha(content)}).`;
}

async function edit(target: string, shown: (path: string) => string, request: FolderRequest, run: FolderRun): Promise<string> {
  const oldText = text(request.old_text);
  const newText = text(request.new_text);
  if (!oldText || newText === undefined) throw new FolderRefusal(400, "edit needs old_text and new_text.");
  const before = await current(target, run);
  if (!before) throw new FolderRefusal(404, `${shown(target)} does not exist; use write to create it.`);
  if (before.length > FOLDER_EDIT_BYTES) throw new FolderRefusal(413, "That file is over 8 MiB; edit it with run_on_computer.");
  const body = before.toString("utf8");
  const count = body.split(oldText).length - 1;
  if (count === 0) throw new FolderRefusal(409, `old_text was not found in ${shown(target)}. Read the file and copy the text exactly.`);
  if (count > 1 && request.replace_all !== true) throw new FolderRefusal(409, `old_text appears ${count} times in ${shown(target)}; add more surrounding text or pass replace_all.`);
  const after = request.replace_all === true ? body.split(oldText).join(newText) : body.replace(oldText, () => newText);
  await save(target, after, run);
  return `Edited ${shown(target)} (${count} change${count === 1 ? "" : "s"}, sha256 ${sha(after)}).`;
}

async function remove(target: string, root: string, shown: (path: string) => string, run: FolderRun): Promise<string> {
  if (target === root) throw new FolderRefusal(403, "Your working folder itself cannot be deleted.");
  const stat = await run(target, () => lstat(target));
  if (stat.isDirectory()) {
    const entries = await run(target, () => readdir(target));
    if (entries.length) throw new FolderRefusal(409, `${shown(target)} is not empty; delete its files first.`);
    await run(target, () => rmdir(target));
  } else await run(target, () => unlink(target));
  return `Deleted ${shown(target)}.`;
}
