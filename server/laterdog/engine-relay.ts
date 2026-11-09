import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { EngineFileReceiver, engineFileKey, engineInventory, readEngineFile, type EngineFile, type EngineFileRoot } from "./engine-files.ts";

// Tests mirror the home under a scratch folder; production mirrors the same absolute paths.
const TEST_ROOT = process.env.LATERDOG_ENGINE_TEST_ROOT ?? "";
let homeRoots: string[] = [];
const mirrored = (value: string) => TEST_ROOT && homeRoots.some((root) => value === root || value.startsWith(`${root}/`)) ? `${TEST_ROOT}${value}` : value;
let roots: EngineFileRoot[] = [];
let outputs: EngineFileRoot[] = [];
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
  const bytes = readEngineFile(root, file.path);
  await send({ type: "file_begin", file });
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) await send({ type: "file_chunk", data: bytes.subarray(offset, offset + 32 * 1024).toString("base64") });
  await send({ type: "file_end" });
}
function checkpoint(): Promise<void> {
  const run = checkpointWork.then(async () => {
    const files = engineInventory(outputs);
    const current = new Map(files.map(file => [engineFileKey(file), file]));
    for (const file of files) if (baseline.get(engineFileKey(file))?.hash !== file.hash) await sendFile(file);
    for (const [key, file] of baseline) if (!current.has(key)) await send({ type: "file_remove", file });
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

// One engine per chat on a computer: a second launch for the same chat is refused while the
// first still runs, so a lost connection can never leave two copies of one conversation working.
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
      // Its relay is gone, so nothing the old engine does can reach the home: stop it before
      // this chat's engine starts again.
      if (Number.isSafeInteger(engine) && engine > 1) {
        // On Linux, only a group that is still a relocated engine (process ids can be reused).
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
          // A home tool may read the working folder (attach_file, for one), so the home gets the
          // engine's edits before a tool call reaches it.
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
  for (const file of engineInventory(roots)) receiver.baseline.set(engineFileKey(file), file);
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
      outputs = roots.filter(root => frame.outputIds.includes(root.id));
      for (const name of frame.names) names.add(name);
      for (const root of roots) mkdirSync(root.path, { recursive: true, mode: 0o700 });
      receiver = new EngineFileReceiver(roots.map(root => ({ ...root, writable: true })), engineInventory(roots));
      await reply(frame.id, { files: engineInventory(roots) });
      return;
    case "file_begin": receiver.begin(frame.file); return;
    case "file_chunk": receiver.chunk(Buffer.from(frame.data, "base64")); return;
    case "file_end": receiver.end(); return;
    case "file_remove": receiver.remove(frame.file); return;
    case "prepared": await reply(frame.id, { prepared: true }); return;
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
