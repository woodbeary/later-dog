import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ENGINE_FILE_LIMIT, EngineFileReceiver, engineFileKey, engineInventory, readEngineFile, type EngineFile, type EngineFileRoot } from "./engine-files.ts";
import { hashFile, pickArtifacts, readWorkspaceFile, walkWorkspace, workspaceGit, workspaceHasFiles, workspaceManifest, WORKSPACE_CAPS, type ManifestEntry, type WorkspaceCaps } from "./engine-workspace.ts";

const TEST_ROOT = process.env.LATERDOG_ENGINE_TEST_ROOT ?? "";
let homeRoots: string[] = [];
const mirrored = (value: string) => TEST_ROOT && homeRoots.some((root) => value === root || value.startsWith(`${root}/`)) ? `${TEST_ROOT}${value}` : value;
const onComputer = (value: string) => TEST_ROOT ? `${TEST_ROOT}${value}` : value;
let roots: EngineFileRoot[] = [];
let synced: EngineFileRoot[] = [];
let outputs: EngineFileRoot[] = [];
interface Ownership { root: EngineFileRoot; artifacts: Map<string, string>; patchHash: string | null; caps: WorkspaceCaps; cacheFile: string }
let ownership: Ownership | null = null;
const READ_LIMIT = 32 * 1024 * 1024;
let receiver: EngineFileReceiver;
let baseline = new Map<string, EngineFile>();
let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
let socketPath = "";
let stateFile = "";
let transportLost = false;
let stdoutWork = Promise.resolve();
let checkpointWork = Promise.resolve();
let sequence = 0;
const acknowledgements = new Map<number, () => void>();
const sockets = new Map<string, Socket>();
const names = new Set<string>();
let server: ReturnType<typeof createServer> | null = null;

async function send(frame: unknown): Promise<void> {
  if (transportLost) throw new Error("Engine transport ended");
  if (!process.stdout.write(`${JSON.stringify(frame)}\n`)) await once(process.stdout, "drain");
}
async function sendFile(file: EngineFile): Promise<void> {
  const root = roots.find(root => root.id === file.root)!;
  await sendBytes(file, readEngineFile(root, file.path));
}
async function sendBytes(file: EngineFile, bytes: Buffer): Promise<void> {
  await send({ type: "file_begin", file });
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) await send({ type: "file_chunk", data: bytes.subarray(offset, offset + 32 * 1024).toString("base64") });
  await send({ type: "file_end" });
}
async function streamFile(file: EngineFile, full: string): Promise<boolean> {
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).size !== file.size) return false;
    await send({ type: "file_begin", file });
    const buffer = Buffer.allocUnsafe(32 * 1024);
    for (let read; (read = readSync(fd, buffer, 0, buffer.length, null)) > 0;) await send({ type: "file_chunk", data: buffer.subarray(0, read).toString("base64") });
    await send({ type: "file_end" });
    return true;
  } finally { closeSync(fd); }
}
function cachedManifest(path: string): ManifestEntry[] {
  try { const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; return Array.isArray(parsed) ? parsed as ManifestEntry[] : []; } catch { return []; }
}
async function sendOwnership(owned: Ownership): Promise<void> {
  const previous = owned.cacheFile ? cachedManifest(owned.cacheFile) : [];
  const manifest = workspaceManifest(owned.root.path, owned.caps, previous);
  const git = workspaceGit(owned.root.path, owned.caps);
  manifest.git = git?.git ?? null;
  const patch = git?.patch ?? null;
  if ((manifest.git?.patchHash ?? null) !== owned.patchHash) {
    if (patch) await sendBytes({ root: "workspace-git", path: "work.patch", hash: manifest.git!.patchHash!, size: patch.length, mode: 0o600 }, patch);
    else if (owned.patchHash) await send({ type: "file_remove", file: { root: "workspace-git", path: "work.patch" } });
    owned.patchHash = manifest.git?.patchHash ?? null;
  }
  const picked = pickArtifacts(manifest, owned.caps, patch?.length ?? 0);
  const kept = new Map<string, string>();
  for (const artifact of picked) {
    if (owned.artifacts.get(artifact.path) === artifact.hash) { kept.set(artifact.path, artifact.hash); continue; }
    let read;
    try { read = readWorkspaceFile(owned.root, artifact.path, owned.caps.artifactFileBytes); } catch { continue; }
    await sendBytes({ root: "workspace-artifact", path: artifact.path, hash: read.hash, size: read.bytes.length, mode: 0o600 }, read.bytes);
    kept.set(artifact.path, read.hash);
  }
  for (const path of owned.artifacts.keys()) if (!kept.has(path)) await send({ type: "file_remove", file: { root: "workspace-artifact", path } });
  owned.artifacts = kept;
  await send({ type: "workspace_manifest", manifest });
  if (owned.cacheFile) {
    try { mkdirSync(dirname(owned.cacheFile), { recursive: true, mode: 0o700 }); writeFileSync(owned.cacheFile, JSON.stringify(manifest.files), { mode: 0o600 }); } catch {}
  }
}
async function exportWorkspace(id: unknown, path: unknown): Promise<void> {
  if (typeof path !== "string" || !path.startsWith("/")) { await reply(id, { error: "An absolute workspace folder is needed." }); return; }
  const root = onComputer(path);
  let files = 0;
  let bytes = 0;
  const tooLarge: string[] = [];
  const changed: string[] = [];
  const entries: Array<{ path: string; full: string }> = [];
  walkWorkspace(root, (name, full) => { entries.push({ path: name, full }); });
  for (const entry of entries) {
    let hashed;
    try { hashed = hashFile(entry.full); } catch { changed.push(entry.path); continue; }
    if (hashed.size > ENGINE_FILE_LIMIT) { tooLarge.push(entry.path); continue; }
    const mode = fstatMode(entry.full);
    if (!(await streamFile({ root: "workspace", path: entry.path, hash: hashed.hash, size: hashed.size, mode }, entry.full))) { changed.push(entry.path); continue; }
    files += 1;
    bytes += hashed.size;
  }
  await reply(id, { files, bytes, tooLarge, changed });
}
function fstatMode(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return fstatSync(fd).mode & 0o777; } finally { closeSync(fd); }
}
function checkpoint(): Promise<void> {
  const run = checkpointWork.then(async () => {
    const files = engineInventory(outputs);
    const current = new Map(files.map(file => [engineFileKey(file), file]));
    for (const file of files) if (baseline.get(engineFileKey(file))?.hash !== file.hash) await sendFile(file);
    for (const [key, file] of baseline) if (!current.has(key)) await send({ type: "file_remove", file });
    if (ownership) await sendOwnership(ownership);
    const id = ++sequence;
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { acknowledgements.delete(id); reject(new Error("Engine checkpoint was not acknowledged")); }, 30_000);
      acknowledgements.set(id, () => { clearTimeout(timer); resolve(); });
    });
    await send({ type: "checkpoint", id });
    await acknowledged;
    baseline = new Map(engineInventory(outputs).map(file => [engineFileKey(file), file]));
    receiver.resetBudget();
    if (stateFile) writeFileSync(stateFile, JSON.stringify([...baseline.values()]), { mode: 0o600 });
  });
  checkpointWork = run.catch(() => {});
  return run;
}
function kill(signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}
function fail(error?: unknown): void {
  if (transportLost) return;
  if (error instanceof Error) process.stderr.write(`engine relay stopped: ${error.message}\n`);
  transportLost = true;
  receiver?.close();
  kill();
  for (const socket of sockets.values()) socket.destroy();
  server?.close();
  setTimeout(() => { kill("SIGKILL"); process.exit(1); }, 5_000);
  if (!child) process.exit(1);
}
const reply = (id: unknown, body: unknown) => send({ type: "reply", id, body });

let lockFile = "";
function takeLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      lockFile = path;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const [holder, engine] = readFileSync(path, "utf8").split(" ").map(Number);
      try { if (Number.isSafeInteger(holder) && holder > 1) { process.kill(holder, 0); return false; } } catch {}
      if (Number.isSafeInteger(engine) && engine > 1) {
        let ours = process.platform !== "linux";
        try { ours = readFileSync(`/proc/${engine}/environ`, "latin1").includes("LATERDOG_ENGINE_SOCKET="); } catch {}
        if (ours) try { process.kill(-engine, "SIGKILL"); } catch {}
      }
      try { unlinkSync(path); } catch {}
    }
  }
  return false;
}
process.on("exit", () => { if (lockFile) try { if (readFileSync(lockFile, "utf8").split(" ")[0] === String(process.pid)) unlinkSync(lockFile); } catch {} });

async function launch(frame: any): Promise<void> {
  if (child) throw new Error("Engine already started");
  socketPath = frame.socketPath;
  stateFile = frame.stateFile;
  if (typeof socketPath !== "string" || typeof stateFile !== "string" || typeof frame.lockFile !== "string") throw new Error("Missing engine state paths");
  if (!takeLock(frame.lockFile)) { await reply(frame.id, { refused: "busy" }); return; }
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  try { unlinkSync(socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  server = createServer(socket => {
    const id = String(++sequence);
    sockets.set(id, socket);
    const input = createInterface({ input: socket });
    input.on("error", () => {});
    let opened = false;
    let work = Promise.resolve();
    input.on("line", line => {
      work = work.then(async () => {
        if (line.length > 2 * 1024 * 1024) throw new Error("Engine proxy input too large");
        const message = JSON.parse(line);
        if (message.type === "open" && !opened && names.has(message.name)) {
          opened = true;
          await send({ type: "proxy_open", id, name: message.name });
        } else if (message.type === "hook" && !opened) {
          opened = true;
          await send({ type: "hook", id, index: Number.isSafeInteger(message.index) ? message.index : 0, payload: message.payload });
        } else if (message.type === "data" && opened) {
          if (Buffer.from(String(message.data), "base64").includes("tools/call")) await checkpoint();
          await send({ type: "proxy_stdin", id, data: message.data });
        } else if (message.type === "end" && opened) await send({ type: "proxy_end", id });
        else throw new Error("Invalid engine proxy frame");
      }).catch(() => { socket.destroy(); });
    });
    socket.on("error", () => {});
    socket.on("close", () => { sockets.delete(id); void send({ type: "proxy_close", id }).catch(() => {}); });
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socketPath, resolve); });
  baseline = new Map(engineInventory(outputs).map(file => [engineFileKey(file), file]));
  receiver.baseline.clear();
  for (const file of engineInventory(synced)) receiver.baseline.set(engineFileKey(file), file);
  try {
    const env = Object.fromEntries(Object.entries(frame.env as Record<string, string>).map(([key, value]) => [key, mirrored(value)]));
    child = spawn(frame.cli, (frame.args as string[]).map(mirrored), { cwd: mirrored(frame.cwd), env: { ...env, LATERDOG_ENGINE_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    await Promise.race([once(child, "spawn"), once(child, "error").then(([error]) => { throw error; })]);
  } catch (error) {
    child = null;
    server?.close();
    await reply(frame.id, { refused: "spawn_failed", code: (error as NodeJS.ErrnoException).code ?? null });
    return;
  }
  child.stdin.on("error", () => {});
  try { writeFileSync(lockFile, `${process.pid} ${child.pid}`, { mode: 0o600 }); } catch {}
  const nativeLines = createInterface({ input: child.stdout });
  nativeLines.on("line", line => {
    stdoutWork = stdoutWork.then(async () => {
      let event: any;
      try { event = JSON.parse(line); } catch {}
      if (event?.type === "result" || event?.method === "turn/completed") await checkpoint();
      await send({ type: "stdout", data: Buffer.from(`${line}\n`).toString("base64") });
    }).catch(fail);
  });
  child.stderr.on("data", bytes => { void send({ type: "stderr", data: Buffer.from(bytes).toString("base64") }).catch(fail); });
  child.on("error", () => { void send({ type: "native_error" }).catch(fail); });
  child.on("close", (code, signal) => {
    void (async () => {
      if (transportLost) { kill("SIGKILL"); process.exit(1); }
      await stdoutWork;
      await checkpoint();
      await send({ type: "native_exit", code, signal });
      receiver.close();
      for (const socket of sockets.values()) socket.destroy();
      server?.close();
      process.exit(0);
    })().catch(fail);
  });
  await reply(frame.id, { started: true, pid: child.pid });
}

async function handle(frame: any): Promise<void> {
  switch (frame.type) {
    case "configure":
      if (receiver || child) throw new Error("Engine already configured");
      homeRoots = frame.roots.map((root: EngineFileRoot) => root.path);
      roots = frame.roots.map((root: EngineFileRoot) => ({ ...root, path: mirrored(root.path) }));
      ownership = null;
      if (frame.ownership && typeof frame.ownership.root === "string") {
        const root = roots.find(root => root.id === frame.ownership.root);
        if (!root) throw new Error("Owned workspace is not one of the engine folders");
        const artifacts = new Map<string, string>();
        for (const artifact of Array.isArray(frame.ownership.artifacts) ? frame.ownership.artifacts : []) if (typeof artifact?.path === "string" && typeof artifact?.hash === "string") artifacts.set(artifact.path, artifact.hash);
        ownership = { root, artifacts, patchHash: typeof frame.ownership.patchHash === "string" ? frame.ownership.patchHash : null,
          caps: { ...WORKSPACE_CAPS, ...frame.ownership.caps }, cacheFile: typeof frame.ownership.cacheFile === "string" ? mirrored(frame.ownership.cacheFile) : "" };
      }
      synced = roots.filter(root => root !== ownership?.root);
      outputs = synced.filter(root => frame.outputIds.includes(root.id));
      for (const name of frame.names) names.add(name);
      for (const root of roots) mkdirSync(root.path, { recursive: true, mode: 0o700 });
      const inventoried = ownership && frame.ownership.reseed === true ? roots : synced;
      receiver = new EngineFileReceiver(roots.map(root => ({ ...root, writable: true })), engineInventory(inventoried));
      await reply(frame.id, { files: engineInventory(inventoried), ...(ownership ? { owned: { hasFiles: workspaceHasFiles(ownership.root.path) } } : {}) });
      return;
    case "file_begin": receiver.begin(frame.file); return;
    case "file_chunk": receiver.chunk(Buffer.from(frame.data, "base64")); return;
    case "file_end": receiver.end(); return;
    case "file_remove": receiver.remove(frame.file); return;
    case "prepared": await reply(frame.id, { prepared: true }); return;
    case "read": {
      if (typeof frame.path !== "string" || !frame.path.startsWith("/")) { await reply(frame.id, { error: "An absolute workspace folder is needed." }); return; }
      try {
        const limit = Math.min(Number(frame.limit) || READ_LIMIT, READ_LIMIT);
        const read = readWorkspaceFile({ id: "read", path: onComputer(frame.path), writable: false }, String(frame.name), limit);
        await reply(frame.id, { data: read.bytes.toString("base64"), hash: read.hash, size: read.bytes.length });
      } catch (error) {
        await reply(frame.id, { error: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : (error as Error).message });
      }
      return;
    }
    case "export": await exportWorkspace(frame.id, frame.path); return;
    case "launch": await launch(frame); return;
    case "stdin": child?.stdin.write(Buffer.from(frame.data, "base64")); return;
    case "end": child?.stdin.end(); return;
    case "stop": kill(); setTimeout(() => kill("SIGKILL"), 3_000).unref(); return;
    case "ack": acknowledgements.get(frame.id)?.(); acknowledgements.delete(frame.id); return;
    case "checkpoint_request":
      await checkpoint();
      await reply(frame.id, { saved: true });
      return;
    case "proxy_stdout":
    case "proxy_stderr":
      if (sockets.get(frame.id)?.writable) sockets.get(frame.id)!.write(`${JSON.stringify({ type: frame.type === "proxy_stdout" ? "stdout" : "stderr", data: frame.data })}\n`);
      return;
    case "proxy_exit":
      if (sockets.get(frame.id)?.writable) sockets.get(frame.id)!.end(`${JSON.stringify({ type: "exit", code: frame.code })}\n`);
      return;
    case "hook_result":
      if (sockets.get(frame.id)?.writable) sockets.get(frame.id)!.end(`${JSON.stringify({ type: "hook_result", body: frame.body })}\n`);
      return;
    default: throw new Error("Unsupported engine frame");
  }
}
const lines = createInterface({ input: process.stdin });
lines.on("error", fail);
lines.on("line", line => {
  if (line.length > 2 * 1024 * 1024) { fail(); return; }
  try { void handle(JSON.parse(line)).catch(fail); } catch (error) { fail(error); }
});
process.stdin.on("end", fail);
process.stdin.on("error", fail);
process.stdout.on("error", fail);
process.on("SIGTERM", fail);
process.on("SIGINT", fail);
void send({ type: "ready" });
