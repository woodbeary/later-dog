import { createHash } from "node:crypto";
import { lstatSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { EngineFileReceiver, engineFileKey, type EngineFile } from "./engine-files.ts";
import { pointerPaths, readPointer, savePointer, type WorkspacePointer } from "./engine-pointer.ts";
import type { EngineLink } from "./engine-remote.ts";
import { hashFile, readWorkspaceFile } from "./engine-workspace.ts";

export const WORKSPACE_READ_LIMIT = 32 * 1024 * 1024;
export const BRING_HOME_MARGIN_BYTES = 512 * 1024 * 1024;
const READY_MS = 30_000;
const READ_MS = 120_000;
const EXPORT_MS = 60 * 60_000;

export class WorkspaceAccessError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

type Reply = Record<string, unknown>;
interface FileSink { begin(file: EngineFile): void; chunk(bytes: Buffer): void; end(): void }

export class RelayCall {
  readonly #link: EngineLink;
  readonly #pending = new Map<number, { resolve(body: Reply): void; reject(error: Error): void }>();
  readonly #ready: Promise<void>;
  #sequence = 0;
  #closed: string | null = null;
  sink: FileSink | null = null;

  constructor(link: EngineLink) {
    this.#link = link;
    let ready!: () => void;
    let failed!: (error: Error) => void;
    this.#ready = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    this.#ready.catch(() => {});
    const timer = setTimeout(() => failed(new Error("the engine relay on the cloud computer did not answer")), READY_MS);
    timer.unref?.();
    link.on("line", (line: string) => {
      let frame: Reply;
      try { frame = JSON.parse(line) as Reply; } catch { return; }
      switch (frame.type) {
        case "ready": clearTimeout(timer); ready(); return;
        case "reply": { const id = Number(frame.id); const pending = this.#pending.get(id); this.#pending.delete(id); pending?.resolve((frame.body ?? {}) as Reply); return; }
        case "file_begin": this.sink?.begin(frame.file as EngineFile); return;
        case "file_chunk": this.sink?.chunk(Buffer.from(String(frame.data), "base64")); return;
        case "file_end": this.sink?.end(); return;
        default: return;
      }
    });
    link.on("close", (why: string) => {
      clearTimeout(timer);
      this.#closed = why;
      failed(new Error(`the cloud computer connection ended (${why})`));
      for (const pending of this.#pending.values()) pending.reject(new Error(`the cloud computer connection ended (${why})`));
      this.#pending.clear();
    });
  }

  async request(frame: Reply, timeoutMs: number): Promise<Reply> {
    await this.#ready;
    if (this.#closed) throw new Error(`the cloud computer connection ended (${this.#closed})`);
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`the engine relay did not answer ${String(frame.type)}`)); }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: (body) => { clearTimeout(timer); resolve(body); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.#link.send(JSON.stringify({ ...frame, id }));
    });
  }

  async control(frame: Parameters<NonNullable<EngineLink["control"]>>[0]): Promise<unknown> {
    if (!this.#link.control) throw new Error("this connection to the cloud computer cannot change a workspace hold");
    return this.#link.control(frame);
  }

  close(): void { try { this.#link.close(); } catch {} }
}

const validName = (path: string) => path.length > 0 && path.length <= 4096 && !path.includes("\0") && !path.startsWith("/")
  && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface WorkspaceRead {
  bytes: Buffer;
  hash: string;
  source: "computer" | "artifact" | "home";
  matchesManifest: boolean | null;
  note?: string;
}

export interface WorkspaceAccessInput {
  dataDir: string;
  botId: string;
  cwd: string;
  relay: () => Promise<EngineLink>;
}

function readLocal(root: string, name: string): { bytes: Buffer; hash: string } | null {
  try { return readWorkspaceFile({ id: "local", path: root, writable: false }, name, WORKSPACE_READ_LIMIT); } catch { return null; }
}

export async function readOwnedWorkspaceFile(input: WorkspaceAccessInput & { path: string; timeoutMs?: number }): Promise<WorkspaceRead> {
  if (!validName(input.path)) throw new WorkspaceAccessError("Give a path inside the workspace.", 400);
  const pointer = readPointer(input.dataDir, input.botId, input.cwd);
  if (!pointer || pointer.state !== "held" || !pointer.seeded) {
    const local = readLocal(input.cwd, input.path);
    if (!local) throw new WorkspaceAccessError("That file is not in the workspace.", 404);
    return { ...local, source: "home", matchesManifest: null };
  }
  const entry = pointer.manifest?.files.find((file) => file.path === input.path) ?? null;
  const compare = (hash: string) => entry ? entry.hash === hash : null;
  let why: string;
  let call: RelayCall | null = null;
  try {
    call = new RelayCall(await input.relay());
    const body = await call.request({ type: "read", path: pointer.cwd, name: input.path, limit: WORKSPACE_READ_LIMIT }, input.timeoutMs ?? READ_MS);
    if (typeof body.data === "string") {
      const bytes = Buffer.from(body.data, "base64");
      const hash = sha(bytes);
      if (hash !== body.hash) throw new Error("the file changed while it was read");
      return { bytes, hash, source: "computer", matchesManifest: compare(hash) };
    }
    if (body.error === "missing") throw new WorkspaceAccessError("That file is not in the workspace on the dog's cloud computer.", 404);
    why = String(body.error ?? "the relay gave no file");
  } catch (error) {
    if (error instanceof WorkspaceAccessError) throw error;
    why = (error as Error).message;
  } finally { call?.close(); }
  if (entry) {
    const paths = pointerPaths(input.dataDir, input.botId, input.cwd);
    for (const [source, root] of [["artifact", paths.artifacts], ["home", input.cwd]] as const) {
      const local = readLocal(root, input.path);
      if (local && local.hash === entry.hash) {
        return { ...local, source, matchesManifest: true, note: `The cloud computer could not be reached (${why}); this is the copy saved at ${new Date(pointer.manifest!.at).toISOString()}.` };
      }
    }
  }
  throw new WorkspaceAccessError(`That file is only on the dog's cloud computer, which could not be reached: ${why}`, 503);
}

export interface BroughtHome { files: number; bytes: number; conflicts: string[]; released: boolean }

export function homeFreeBytes(cwd: string): number {
  let at = cwd;
  for (;;) {
    try { const stats = statfsSync(at); return Number(stats.bavail) * Number(stats.bsize); }
    catch { if (dirname(at) === at) return 0; at = dirname(at); }
  }
}

export async function bringWorkspaceHome(input: WorkspaceAccessInput & { freeBytes?: (cwd: string) => number; now?: () => number }): Promise<BroughtHome> {
  const now = input.now ?? Date.now;
  const pointer = readPointer(input.dataDir, input.botId, input.cwd);
  if (!pointer) throw new WorkspaceAccessError("This workspace has no record of living on the dog's cloud computer.", 404);
  if (pointer.state === "home") return { files: 0, bytes: 0, conflicts: [], released: true };
  const paths = pointerPaths(input.dataDir, input.botId, input.cwd);
  const call = new RelayCall(await input.relay().catch((error: Error) => { throw new WorkspaceAccessError(`The dog's cloud computer could not be reached: ${error.message}`, 503); }));
  try {
    let files = 0;
    let bytes = 0;
    const conflicts: string[] = [];
    const failures: string[] = [];
    if (pointer.seeded) {
      const needed = pointer.manifest?.totalBytes ?? 0;
      const free = (input.freeBytes ?? homeFreeBytes)(pointer.cwd);
      if (needed + BRING_HOME_MARGIN_BYTES > free) {
        throw new WorkspaceAccessError(`Bringing this workspace home needs about ${needed + BRING_HOME_MARGIN_BYTES} bytes and the home has ${free} free, so it was left on the computer.`, 507);
      }
      const receiver = new EngineFileReceiver([{ id: "workspace", path: pointer.cwd, writable: true }, { id: "conflict", path: paths.conflicts, writable: true }]);
      let current: EngineFile | null = null;
      let skipping = false;
      call.sink = {
        begin(file) {
          skipping = false;
          current = null;
          try {
            const target = homeTarget(pointer, paths.conflicts, file);
            current = { ...file, root: target.root };
            if (target.root === "conflict") conflicts.push(file.path);
            if (target.hash) receiver.baseline.set(engineFileKey(current), { ...current, hash: target.hash });
            receiver.begin(current);
          } catch (error) { skipping = true; failures.push(`${file.path}: ${(error as Error).message}`); }
        },
        chunk(chunk) { if (!skipping) try { receiver.chunk(chunk); } catch (error) { skipping = true; receiver.close(); failures.push(`${current?.path}: ${(error as Error).message}`); } },
        end() {
          if (skipping) { skipping = false; return; }
          try { receiver.end(); files += 1; bytes += current?.size ?? 0; } catch (error) { failures.push(`${current?.path}: ${(error as Error).message}`); }
          receiver.resetBudget();
        },
      };
      const body = await call.request({ type: "export", path: pointer.cwd }, EXPORT_MS);
      if (typeof body.error === "string") throw new WorkspaceAccessError(`The computer could not send the workspace: ${body.error}`, 502);
      const left = [...(Array.isArray(body.tooLarge) ? body.tooLarge : []), ...(Array.isArray(body.changed) ? body.changed : [])].map(String);
      if (left.length || failures.length) {
        savePointer(input.dataDir, { ...pointer, broughtHome: { at: now(), files, bytes, conflicts } });
        throw new WorkspaceAccessError(`Copied ${files} file(s) home, but ${left.length + failures.length} could not come; the workspace stays held on the computer: ${[...left, ...failures].slice(0, 10).join("; ")}`, 409);
      }
    }
    let released = false;
    try {
      await call.control({ channel: "release", key: pointer.key, through: pointer.writtenAt });
      released = true;
    } catch (error) {
      savePointer(input.dataDir, { ...pointer, broughtHome: { at: now(), files, bytes, conflicts } });
      throw new WorkspaceAccessError(`The files came home, but the computer kept its hold: ${(error as Error).message}`, 409);
    }
    const latest = readPointer(input.dataDir, input.botId, input.cwd) ?? pointer;
    if (latest.writtenAt > pointer.writtenAt) {
      throw new WorkspaceAccessError("The dog wrote to this workspace while it was being brought home; try again when it is idle.", 409);
    }
    savePointer(input.dataDir, { ...latest, state: "home", seeded: false, broughtHome: { at: now(), files, bytes, conflicts } });
    return { files, bytes, conflicts, released };
  } finally { call.close(); }
}

function existingHash(full: string): string | null {
  let stat;
  try { stat = lstatSync(full); } catch { return null; }
  if (!stat.isFile()) throw new Error("the home has something other than a file at this path");
  return hashFile(full).hash;
}

function homeTarget(pointer: WorkspacePointer, conflicts: string, file: EngineFile): { root: "workspace" | "conflict"; hash: string | null } {
  if (!validName(file.path)) throw new Error("invalid path from the computer");
  const full = join(pointer.cwd, file.path);
  const hash = existingHash(full);
  if (hash === null || hash === file.hash || lstatSync(full).mtimeMs <= pointer.seededAt) return { root: "workspace", hash };
  return { root: "conflict", hash: existingHash(join(conflicts, file.path)) };
}
