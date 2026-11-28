import { runFolderCommand } from "./engine-folder-process.ts";
import { ENGINE_FOLDER_STATE, guestFolderDir, type EngineWorkFolder } from "./engine-folder-sync.ts";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "../atomic.ts";
import { once } from "node:events";
import { closeSync, constants, existsSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ENGINE_FRAME_BYTES, ENGINE_WINDOW_BYTES, EngineFileReceiver, sameEngineFile, streamedTree, decodeEngineChunk, engineFileChunks, engineFileKey, engineFilePath, engineInventory, fileHash, inventoryWork, runFileWork, matchingTranscriptPrefix, selectEngineTranscript, selectedTranscript, type EngineFile, type EngineFileRoot } from "./engine-files.ts";

const TEST_ROOT = process.env.LATERDOG_ENGINE_TEST_ROOT ?? "";
let homeRoots: string[] = [];
const mirrored = (value: string) => TEST_ROOT && homeRoots.some((root) => value === root || value.startsWith(`${root}/`)) ? `${TEST_ROOT}${value}` : value;
const placedRoot = (root: EngineFileRoot) => TEST_ROOT && typeof root.remotePath === "string" && root.remotePath.startsWith(`${TEST_ROOT}/`) && !root.remotePath.split("/").includes("..") ? root.remotePath : mirrored(root.path);
let roots: EngineFileRoot[] = [];
let outputs: EngineFileRoot[] = [];
let workFolders: EngineWorkFolder[] = [];
const fileAbort = new AbortController();
const folderState = TEST_ROOT ? join(TEST_ROOT, ".folder-state") : ENGINE_FOLDER_STATE;
const CHECKED_OUT_FRESH_MS = 30_000;
async function syncWorkFolders(action: "hydrate" | "checkpoint") {
  for (const target of workFolders) await runFolderCommand(action, target, {signal:fileAbort.signal, onProgress:()=>{void send({type:"file_progress"}).catch(fail);}, ...(TEST_ROOT ? {entry:process.env.LATERDOG_ENGINE_FOLDER_TEST_CLI,state:folderState} : {})});
}
function checkedOutJustNow(): boolean {
  return workFolders.every(target => {
    try { return Date.now() - statSync(join(guestFolderDir(target.path, folderState), "checked.json")).mtimeMs < CHECKED_OUT_FRESH_MS; }
    catch { return false; }
  });
}
let receiver: EngineFileReceiver;
let baseline = new Map<string, EngineFile>();
let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
let socketPath = "";
let stateFile = "";
let transportLost = false;
let stdoutWork = Promise.resolve();
let checkpointWork = Promise.resolve();
let sequence = 0;
let pendingFileBytes = 0;
const acknowledgements = new Map<number, (reason?: string) => void>();
const sockets = new Map<string, Socket>();
const names = new Set<string>();
let server: ReturnType<typeof createServer> | null = null;

async function send(frame: unknown): Promise<void> {
  if (transportLost) throw new Error("Engine transport ended");
  if (!process.stdout.write(`${JSON.stringify(frame)}\n`)) await once(process.stdout, "drain");
}
const requestedAckMs = Number(process.env.LATERDOG_ENGINE_ACK_MS);
const ACK_SILENCE_MS = Number.isFinite(requestedAckMs) && requestedAckMs > 0 ? requestedAckMs : 30_000;
const ACK_LONGEST_MS = 20 * ACK_SILENCE_MS;
let homeHeardAt = Date.now();
async function acknowledged(type: "checkpoint" | "file_window", required = false): Promise<void> {
  const id = ++sequence;
  const askedAt = Date.now();
  const settled = new Promise<void>((resolve, reject) => {
    const watch = setInterval(() => {
      const now = Date.now();
      if (now - Math.max(askedAt, homeHeardAt) > ACK_SILENCE_MS || now - askedAt > ACK_LONGEST_MS) {
        clearInterval(watch);
        reject(new Error(`Engine ${type} was not acknowledged`));
      }
    }, Math.min(1_000, Math.max(50, ACK_SILENCE_MS / 4)));
    acknowledgements.set(id, reason => {
      clearInterval(watch);
      if (reason) reject(new Error(reason));
      else resolve();
    });
  });
  try { await Promise.all([settled, send({ type, id, required })]); }
  finally { acknowledgements.delete(id); }
}

function transcriptReceipt(root: EngineFileRoot, name: string): string {
  const key = createHash("sha256").update(ephemeralCodexHome && root.id === "sessions" ? root.id : root.path).update("\0").update(name).digest("hex");
  return `${stateFile}.${key}.json`;
}

function readTranscriptReceipts(): { root: string; path: string; before: EngineFile | null }[] {
  return outputs.flatMap(root => (root.files ?? []).filter(name => selectedTranscript(root, name)).flatMap(name => {
    try {
      const before: EngineFile | null = JSON.parse(readFileSync(transcriptReceipt(root, name), "utf8"));
      if (before !== null && (before.root !== root.id || before.path !== name || !/^[a-f0-9]{64}$/.test(before.hash) || !Number.isSafeInteger(before.size) || before.size < 0)) throw new Error("Invalid native transcript checkpoint receipt");
      return [{ root: root.id, path: name, before }];
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }));
}

function saveTranscriptReceipts(): void {
  for (const root of outputs) for (const name of root.files ?? []) {
    if (selectedTranscript(root, name)) writeFileAtomic(transcriptReceipt(root, name), JSON.stringify(baseline.get(engineFileKey({ root: root.id, path: name })) ?? null), { mode: 0o600 });
  }
}

function workspaceReceiptFile(root: EngineFileRoot): string {
  return `${stateFile}.workspace-${createHash("sha256").update(root.path).digest("hex")}.json`;
}

function readWorkspaceReceipt(root: EngineFileRoot): EngineFile[] {
  try {
    const files: EngineFile[] = JSON.parse(readFileSync(workspaceReceiptFile(root), "utf8"));
    if (!Array.isArray(files) || !files.every(file => file.root === root.id && typeof file.path === "string" && /^[a-f0-9]{64}$/.test(file.hash))) throw new Error("Invalid working folder checkpoint receipt");
    return files;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function saveWorkspaceReceipt() {
  for (const root of outputs.filter(streamedTree)) writeFileAtomic(workspaceReceiptFile(root), JSON.stringify([...baseline.values()].filter(file => file.root === root.id)), { mode: 0o600 });
}

async function inventory(roots: EngineFileRoot[]) {
  let nextNotice = Date.now() + 5000;
  return runFileWork(inventoryWork(roots), undefined, () => {
    if (Date.now() < nextNotice) return;
    nextNotice = Date.now() + 5000;
    void send({ type: "file_progress" }).catch(() => {});
  });
}

async function sendFile(file: EngineFile, before = baseline.get(engineFileKey(file)), recovery = false): Promise<void> {
  const root = roots.find(root => root.id === file.root)!;
  const required = recovery || selectedTranscript(root, file.path);
  const prefix = matchingTranscriptPrefix(root, file, before);
  await send({ type: "file_begin", file, prefix });
  pendingFileBytes += 256 + Buffer.byteLength(file.path);
  for (const bytes of engineFileChunks(root, file.path, ENGINE_FRAME_BYTES, prefix?.size, file.size)) {
    await send({ type: "file_chunk", data: bytes.toString("base64") });
    pendingFileBytes += bytes.length;
    if (pendingFileBytes >= ENGINE_WINDOW_BYTES) {
      await acknowledged("file_window", required);
      pendingFileBytes = 0;
    }
  }
  await send({ type: "file_end" });
  if (required || pendingFileBytes >= ENGINE_WINDOW_BYTES) {
    await acknowledged("file_window", required);
    pendingFileBytes = 0;
  }
}

function afterCheckpoint(work: () => Promise<void>): Promise<void> {
  const run = checkpointWork.then(work);
  checkpointWork = run.catch(() => {});
  return run;
}
function checkpoint(): Promise<void> {
  const run = checkpointWork.then(async () => {
    await syncWorkFolders("checkpoint");
    const files = await inventory(outputs);
    const current = new Map(files.map(file => [engineFileKey(file), file]));
    for (const file of files) if (!sameEngineFile(baseline.get(engineFileKey(file)), file)) await sendFile(file);
    for (const file of [...baseline.values()].reverse()) if (!current.has(engineFileKey(file))) {
      await send({ type: "file_remove", file });
      if (outputs.some(root => root.id === file.root && selectedTranscript(root, file.path))) await acknowledged("file_window", true);
    }
    await acknowledged("checkpoint");
    baseline = current;
    saveTranscriptReceipts();
    saveWorkspaceReceipt();
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
  fileAbort.abort();
  receiver?.close();
  kill();
  for (const socket of sockets.values()) socket.destroy();
  server?.close();
  setTimeout(() => { kill("SIGKILL"); process.exit(1); }, 5_000);
  if (!child) process.exit(1);
}
const reply = (id: unknown, body: unknown) => send({ type: "reply", id, body });

let lockFile = "";
let ephemeralCodexHome: string | null = null;
function bindEphemeralCodexHome(path: string): void {
  const dir = mirrored(path);
  if (!/\/engine-launch\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(dir) || !roots.some(root => root.id === "config" && root.path === dir) || !outputs.some(root => root.id === "sessions" && root.path === join(dir, "sessions"))) throw new Error("The temporary Codex directory could not be verified.");
  mkdirSync(join(dirname(dir), ".transcript-recovery"), { recursive: true, mode: 0o700 });
  ephemeralCodexHome = dir;
}
function parkedTranscript(root: EngineFileRoot, name: string): string | undefined {
  if (!ephemeralCodexHome || root.id !== "sessions" || !selectedTranscript(root, name)) return;
  const key = createHash("sha256").update(stateFile).update("\0").update(name).digest("hex");
  return join(dirname(ephemeralCodexHome), ".transcript-recovery", `${key}.jsonl`);
}
function removeEphemeralCodexHome(completed = false): void {
  if (!ephemeralCodexHome) return;
  rmSync(join(ephemeralCodexHome, "auth.json"), { force: true });
  for (const root of outputs) for (const name of root.files ?? []) {
    const parked = parkedTranscript(root, name);
    if (!parked) continue;
    if (completed) rmSync(parked, { force: true });
    else {
      const resident = engineFilePath(root, name);
      if (existsSync(resident)) {
        mkdirSync(dirname(parked), { recursive: true, mode: 0o700 });
        renameSync(resident, parked);
      }
    }
  }
  rmSync(ephemeralCodexHome, { recursive: true, force: true });
  ephemeralCodexHome = null;
}
process.on("exit", () => { try { removeEphemeralCodexHome(); } catch {} });
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
const PREVIOUS_RELAY_WAIT_MS = 20_000;
const ENGINE_START_WAIT_MS = 60_000;
const ENGINE_START_HOLD_MS = 5_000;
async function holdEngineStart(path: string): Promise<() => void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const giveUpAt = Date.now() + ENGINE_START_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(join(path, "pid"), String(process.pid), { mode: 0o600 });
      let held = true;
      return () => { if (held) { held = false; rmSync(path, { recursive: true, force: true }); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let holder = 0;
      try { holder = Number(readFileSync(join(path, "pid"), "utf8")); } catch {}
      let alive = false;
      try { if (Number.isSafeInteger(holder) && holder > 1) { process.kill(holder, 0); alive = true; } } catch {}
      if (!alive && holder > 1) rmSync(path, { recursive: true, force: true });
      if (Date.now() >= giveUpAt) return () => {};
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
async function takeLockWithin(path: string, waitMs: number): Promise<boolean> {
  const giveUpAt = Date.now() + waitMs;
  while (!takeLock(path)) {
    if (Date.now() >= giveUpAt) return false;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return true;
}
process.on("exit", () => { if (lockFile) try { if (readFileSync(lockFile, "utf8").split(" ")[0] === String(process.pid)) unlinkSync(lockFile); } catch {} });

async function launch(frame: any): Promise<void> {
  if (child) throw new Error("Engine already started");
  if (frame.ephemeralCodexHome && (!ephemeralCodexHome || frame.env?.CODEX_HOME !== frame.ephemeralCodexHome)) throw new Error("Unexpected temporary Codex home");
  socketPath = frame.socketPath;
  stateFile = frame.stateFile;
  if (typeof socketPath !== "string" || typeof stateFile !== "string" || typeof frame.lockFile !== "string") throw new Error("Missing engine state paths");
  if (!lockFile && !takeLock(frame.lockFile)) { await reply(frame.id, { refused: "busy" }); return; }
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
  const installed = await inventory(roots);
  const outputIds = new Set(outputs.map(root => root.id));
  const strict = new Set(outputs.filter(streamedTree).map(root => root.id));
  const selected = [...receiver.baseline.values()].filter(file => strict.has(file.root));
  baseline = new Map([...installed.filter(file => outputIds.has(file.root) && !strict.has(file.root)), ...selected].map(file => [engineFileKey(file), file]));
  saveWorkspaceReceipt();
  const resident = installed.filter(file => strict.has(file.root));
  if (resident.length !== selected.length || resident.some(file => !sameEngineFile(baseline.get(engineFileKey(file)), file))) throw new Error("The working folder changed during preparation. Its copies were preserved.");
  saveTranscriptReceipts();
  receiver.baseline.clear();
  for (const file of installed) receiver.baseline.set(engineFileKey(file), file);
  const startLock = await holdEngineStart(join(dirname(frame.lockFile), "engine-start"));
  try {
    const env = Object.fromEntries(Object.entries(frame.env as Record<string, string>).map(([key, value]) => [key, mirrored(value)]));
    child = spawn(frame.cli, (frame.args as string[]).map(mirrored), { cwd: mirrored(frame.cwd), env: { ...env, LATERDOG_ENGINE_SOCKET: socketPath }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    await Promise.race([once(child, "spawn"), once(child, "error").then(([error]) => { throw error; })]);
  } catch (error) {
    startLock();
    child = null;
    server?.close();
    await reply(frame.id, { refused: "spawn_failed", code: (error as NodeJS.ErrnoException).code ?? null });
    return;
  }
  child.stdout.once("data", startLock);
  child.once("close", startLock);
  setTimeout(startLock, ENGINE_START_HOLD_MS).unref();
  child.stdin.on("error", () => {});
  try { writeFileSync(lockFile, `${process.pid} ${child.pid}`, { mode: 0o600 }); } catch {}
  const nativeLines = createInterface({ input: child.stdout });
  nativeLines.on("line", line => {
    stdoutWork = stdoutWork.then(async () => {
      let event: any;
      try { event = JSON.parse(line); } catch {}
      const turnEnded = event?.type === "result" || event?.method === "turn/completed" || (workFolders.length && event?.event?.type === "turn.completed");
      const savesAfterReply = workFolders.length > 0;
      if (turnEnded && !savesAfterReply) await checkpoint();
      await send({ type: "stdout", data: Buffer.from(`${line}\n`).toString("base64") });
      if (turnEnded && savesAfterReply) await checkpoint();
    }).catch(fail);
  });
  child.stderr.on("data", bytes => { void send({ type: "stderr", data: Buffer.from(bytes).toString("base64") }).catch(fail); });
  child.on("error", () => { void send({ type: "native_error" }).catch(fail); });
  child.on("close", (code, signal) => {
    void (async () => {
      if (transportLost) { kill("SIGKILL"); process.exit(1); }
      await stdoutWork;
      await checkpoint();
      removeEphemeralCodexHome(true);
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
    case "refresh_folders":
      if(!child)throw new Error("Cannot refresh a working folder without an active engine");
      try {await afterCheckpoint(() => checkedOutJustNow() ? Promise.resolve() : syncWorkFolders("hydrate"));await reply(frame.id,{ready:true});}
      catch(error){await reply(frame.id,{error:(error as Error).message});}
      return;
    case "guest_folder_once": {
      if (receiver || child || workFolders.length || !Array.isArray(frame.workFolders) || !["hydrate","checkpoint"].includes(frame.action)) throw new Error("Invalid standalone folder request");
      workFolders = frame.workFolders;
      try {await syncWorkFolders(frame.action);await reply(frame.id,{saved:true});}
      catch (error) {await reply(frame.id,{error:(error as Error).message});}
      return;
    }
    case "configure":
      if (receiver || child) throw new Error("Engine already configured");
      if (!await takeLockWithin(frame.lockFile, PREVIOUS_RELAY_WAIT_MS)) { await reply(frame.id, { refused: "busy" }); return; }
      stateFile = frame.stateFile;
      const bindings: EngineWorkFolder[] = frame.workFolders ?? [];
      homeRoots = [...frame.roots.map((root: EngineFileRoot) => root.path), ...bindings.map(folder => folder.path)];
      workFolders = bindings.map(folder => ({...folder,path:mirrored(folder.path)}));
      try { await syncWorkFolders("hydrate"); }
      catch (error) { await reply(frame.id,{refused: (error as Error).message}); return; }
      roots = frame.roots.map((root: EngineFileRoot) => ({ ...root, logicalPath: root.path, path: placedRoot(root) }));
      outputs = roots.filter(root => frame.outputIds.includes(root.id));
      if (frame.ephemeralCodexHome) bindEphemeralCodexHome(frame.ephemeralCodexHome);
      for (const root of outputs) for (const name of root.files ?? []) {
        const parked = parkedTranscript(root, name);
        if (!parked || !existsSync(parked)) continue;
        const target = engineFilePath(root, name);
        if (existsSync(target)) throw new Error("Unexpected resident Codex recovery target");
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        linkSync(parked, target);
      }
      for (const name of frame.names) names.add(name);
      for (const root of roots) mkdirSync(root.path, { recursive: true, mode: 0o700 });
      const files = await inventory(roots);
      receiver = new EngineFileReceiver(roots, files);
      const trees = outputs.filter(streamedTree);
      if (trees.length) {
        const prior = trees.flatMap(readWorkspaceReceipt);
        for (const [kind, items] of [["resident", files], ["previous", prior]] as const) {
          for (let i = 0; i < items.length; i += 128) await send({ type: "inventory_page", kind, files: items.slice(i, i + 128) });
        }
      }
      await reply(frame.id, { files: trees.length ? [] : files, trees: trees.map(root => root.id), transcripts: readTranscriptReceipts() });
      return;
    case "recover_workspace": {
      if (child || !Array.isArray(frame.files) || frame.files.length > 64) throw new Error("Invalid working folder recovery selection");
      for (const expected of frame.files) {
        const workspace = outputs.find(root => root.id === expected.root && streamedTree(root));
        if (!workspace) throw new Error("Invalid working folder recovery root");
        const item = { root: workspace.id, path: expected.path };
        engineFilePath(workspace, item.path, true);
        const resident = receiver.baseline.get(engineFileKey(item));
        if (!sameEngineFile(resident, expected)) throw new Error("Working file changed before recovery");
        if (resident) await sendFile(resident, undefined, true);
        else {
          if (lstatSync(engineFilePath(workspace, item.path, true), { throwIfNoEntry: false })) throw new Error("A new working file appeared before recovery");
          await send({ type: "file_remove", file: item });
          await acknowledged("file_window", true);
        }
      }
      await reply(frame.id, { recovered: true });
      return;
    }
    case "recover_transcript": {
      const root = outputs.find(root => root.id === frame.root);
      if (child || !root || !selectedTranscript(root, frame.path)) throw new Error("Invalid transcript recovery selection");
      const file = engineInventory([root]).find(file => file.path === frame.path);
      if (file?.hash !== frame.hash) throw new Error("Native transcript changed before recovery");
      if (file) await sendFile(file, readTranscriptReceipts().find(item => item.root === root.id && item.path === frame.path)?.before ?? undefined);
      else { await send({ type: "file_remove", file: { root: root.id, path: frame.path } }); await acknowledged("file_window", true); }
      await reply(frame.id, { recovered: true });
      return;
    }
    case "transcript_prefix": {
      const root = outputs.find(root => root.id === frame.root);
      if (child || !root || !selectedTranscript(root, frame.path) || !Number.isSafeInteger(frame.size) || frame.size < 0) throw new Error("Invalid transcript selection");
      await reply(frame.id, { hash: await runFileWork(fileHash(root, frame.path, frame.size)) });
      return;
    }
    case "set_aside_transcript": {
      const root = outputs.find(root => root.id === frame.root);
      if (child || !receiver || !root || !selectedTranscript(root, frame.path)) throw new Error("Invalid transcript selection");
      const file = engineInventory([root]).find(file => file.path === frame.path);
      if (!file || file.hash !== frame.hash) throw new Error("Native transcript changed before it was set aside");
      const kept = `${frame.path}.computer-${Date.now()}.preserved`;
      renameSync(engineFilePath(root, frame.path), join(dirname(engineFilePath(root, frame.path)), kept.split("/").at(-1)!));
      rmSync(transcriptReceipt(root, frame.path), { force: true });
      receiver.baseline.delete(engineFileKey(file));
      await reply(frame.id, { setAside: kept });
      return;
    }
    case "select_transcript": {
      if (!child) throw new Error("Native process is not running");
      const root = outputs.find(root => root.id === frame.root);
      selectEngineTranscript(root, frame.path);
      saveTranscriptReceipts();
      await reply(frame.id, { selected: true });
      return;
    }
    case "file_begin":
      if (frame.id !== undefined) {
        try { receiver.begin(frame.file, frame.prefix); await reply(frame.id, { accepted: true }); }
        catch (error) { await reply(frame.id, { error: (error as Error).message }); }
      } else receiver.begin(frame.file, frame.prefix);
      return;
    case "file_chunk": receiver.chunk(decodeEngineChunk(frame.data)); return;
    case "file_end": receiver.end(); return;
    case "file_window": await reply(frame.id, { received: true }); return;
    case "file_remove": receiver.remove(frame.file); return;
    case "prepared": await reply(frame.id, { prepared: true }); return;
    case "launch": await launch(frame); return;
    case "stdin": {
      if (frame.id === undefined) { child?.stdin.write(Buffer.from(frame.data, "base64")); return; }
      if (!child || !child.stdin.writable) throw new Error("Engine input closed.");
      const stdin = child.stdin;
      await new Promise<void>((resolve, reject) => stdin.write(Buffer.from(frame.data, "base64"), error => error ? reject(error) : resolve()));
      await reply(frame.id, { received: true });
      return;
    }
    case "end": child?.stdin.end(); return;
    case "stop": kill(); setTimeout(() => kill("SIGKILL"), 3_000).unref(); return;
    case "ack": acknowledgements.get(frame.id)?.(frame.error); acknowledgements.delete(frame.id); return;
    case "working": return;
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
  homeHeardAt = Date.now();
  try { void handle(JSON.parse(line)).catch(fail); } catch (error) { fail(error); }
});
process.stdin.on("end", fail);
process.stdin.on("error", fail);
process.stdout.on("error", fail);
process.on("SIGTERM", fail);
process.on("SIGINT", fail);
void send({ type: "ready", working: true });
