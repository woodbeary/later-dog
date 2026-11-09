import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { EngineFileReceiver, engineFileKey, engineInventory, type EngineFile, type EngineFileRoot } from "./engine-files.ts";
import { readEngineFile } from "./engine-files.ts";
import { createHash } from "node:crypto";

export interface EngineLink extends EventEmitter {
  send(line: string): void;
  close(): void;
}

export function commandLink(command: string, args: string[], env?: NodeJS.ProcessEnv): EngineLink {
  const link = new EventEmitter() as EngineLink;
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: env ?? process.env });
  let closed = false;
  const close = (why: string) => { if (closed) return; closed = true; link.emit("close", why); };
  createInterface({ input: child.stdout }).on("line", (line) => link.emit("line", line));
  child.stderr.on("data", (bytes) => link.emit("diagnostic", String(bytes)));
  child.on("error", () => close("relay could not start"));
  child.on("close", () => close("relay ended"));
  child.stdin.on("error", () => close("relay input closed"));
  link.send = (line) => { if (!closed) child.stdin.write(`${line}\n`); };
  link.close = () => { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref(); };
  return link;
}

export interface StdioSpec { command: string; args?: string[]; env?: Record<string, string> }
export interface PushedFile { root: string; path: string; bytes: Buffer; mode: number }

export interface RemoteLaunch {
  cli: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  roots: EngineFileRoot[];
  outputIds: string[];
  pushes?: () => PushedFile[];
  pushEveryMs?: number;
  mcp: Record<string, StdioSpec>;
  hooks: string[];
  hookEnv: Record<string, string>;
  socketPath: string;
  stateFile: string;
  lockFile: string;
}

export class NotDispatched extends Error {
  readonly refused?: string;
  constructor(message: string, refused?: string) { super(message); this.refused = refused; }
}

const HANDSHAKE_MS = 30_000;
const SYNC_REPLY_MS = 10 * 60_000;
const PUSH_EVERY_MS = 30_000;

type Pending = { resolve: (body: any) => void; reject: (error: Error) => void };

export class RemoteSession extends EventEmitter {
  #link: EngineLink;
  #launch: RemoteLaunch;
  #pending = new Map<number, Pending>();
  #sequence = 0;
  #ready: Promise<void>;
  #closed = false;
  #launchSent = false;
  #started = false;
  #exited = false;
  #receiver: EngineFileReceiver | null = null;
  #skipping = false;
  #proxies = new Map<string, ChildProcess>();
  #pushed = new Map<string, string>();
  #pushTimer: NodeJS.Timeout | null = null;
  conflicts: string[] = [];

  constructor(link: EngineLink, launch: RemoteLaunch) {
    super();
    this.#link = link;
    this.#launch = launch;
    this.#ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new NotDispatched("The cloud computer's engine relay did not answer.")), HANDSHAKE_MS);
      this.once("relay-ready", () => { clearTimeout(timer); resolve(); });
      this.once("link-closed", () => { clearTimeout(timer); reject(new NotDispatched("The cloud computer's engine relay closed before it was ready.")); });
    });
    this.#ready.catch(() => {});
    link.on("line", (line: string) => this.#line(line));
    link.on("diagnostic", (text: string) => this.emit("diagnostic", text));
    link.on("close", (why: string) => this.#lost(why));
  }

  get started(): boolean { return this.#started; }

  #send(frame: unknown): void { this.#link.send(JSON.stringify(frame)); }
  #request(frame: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`The engine relay did not answer ${String(frame.type)}.`)); }, timeoutMs);
      this.#pending.set(id, { resolve: (body) => { clearTimeout(timer); resolve(body); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.#send({ ...frame, id });
    });
  }
  #sendFile(root: string, path: string, bytes: Buffer, mode: number): void {
    const hash = createHash("sha256").update(bytes).digest("hex");
    this.#send({ type: "file_begin", file: { root, path, hash, size: bytes.length, mode } });
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024) this.#send({ type: "file_chunk", data: bytes.subarray(offset, offset + 32 * 1024).toString("base64") });
    this.#send({ type: "file_end" });
  }
  #pushScoped(remote: Map<string, string>): void {
    for (const file of this.#launch.pushes?.() ?? []) {
      const key = engineFileKey(file);
      const hash = createHash("sha256").update(file.bytes).digest("hex");
      if ((this.#pushed.get(key) ?? remote.get(key)) === hash) continue;
      this.#sendFile(file.root, file.path, file.bytes, file.mode);
      this.#pushed.set(key, hash);
    }
  }

  async start(): Promise<void> {
    await this.#ready;
    const launch = this.#launch;
    let configured: { files: EngineFile[] };
    let home: EngineFile[];
    const pushedRoots = new Set((launch.pushes?.() ?? []).map((file) => file.root));
    try {
      home = engineInventory(launch.roots.filter((root) => !pushedRoots.has(root.id)));
    } catch (error) {
      throw new NotDispatched(`The working files cannot move to the cloud computer: ${(error as Error).message}`);
    }
    try {
      configured = await this.#request({ type: "configure", roots: launch.roots.map((root) => ({ ...root, writable: true })), outputIds: launch.outputIds, names: Object.keys(launch.mcp) }, SYNC_REPLY_MS);
    } catch (error) { throw new NotDispatched((error as Error).message); }
    const remote = new Map(configured.files.map((file) => [engineFileKey(file), file.hash]));
    const present = new Set(home.map(engineFileKey));
    for (const file of home) {
      if (remote.get(engineFileKey(file)) === file.hash) continue;
      const root = launch.roots.find((entry) => entry.id === file.root)!;
      this.#sendFile(file.root, file.path, readEngineFile(root, file.path), root.readOnly ? (file.mode & 0o444) | 0o400 : file.mode);
    }
    for (const file of configured.files) if (!present.has(engineFileKey(file)) && !pushedRoots.has(file.root)) this.#send({ type: "file_remove", file });
    this.#pushScoped(remote);
    try { await this.#request({ type: "prepared" }, SYNC_REPLY_MS); }
    catch (error) { throw new NotDispatched((error as Error).message); }
    this.#receiver = new EngineFileReceiver(launch.roots.filter((root) => launch.outputIds.includes(root.id)).map((root) => ({ ...root, writable: true })),
      home.filter((file) => launch.outputIds.includes(file.root)));
    if (this.#closed) throw new NotDispatched("The cloud computer's connection closed before launch.");
    this.#launchSent = true;
    let body: any;
    try {
      body = await this.#request({ type: "launch", cli: launch.cli, args: launch.args, cwd: launch.cwd, env: launch.env,
        socketPath: launch.socketPath, stateFile: launch.stateFile, lockFile: launch.lockFile }, HANDSHAKE_MS);
    } catch (error) {
      throw new Error(`The cloud computer did not confirm the engine started: ${(error as Error).message}`);
    }
    if (body?.refused === "spawn_failed") throw new NotDispatched("The engine could not start on the cloud computer.", "spawn_failed");
    if (body?.refused === "busy") throw new Error("This chat's engine is still running on the cloud computer; it was not started a second time.");
    if (!body?.started) throw new Error("The cloud computer gave an unexpected answer to the engine launch.");
    this.#started = true;
    this.#pushTimer = setInterval(() => this.#pushScoped(new Map()), launch.pushEveryMs ?? PUSH_EVERY_MS);
    this.#pushTimer.unref();
  }

  write(bytes: Buffer): void { if (this.#started && !this.#closed) this.#send({ type: "stdin", data: bytes.toString("base64") }); }
  end(): void { if (this.#started && !this.#closed) this.#send({ type: "end" }); }
  stop(): void { if (!this.#closed) this.#send({ type: "stop" }); }
  close(): void { this.#link.close(); }
  checkpoint(): Promise<unknown> { return this.#request({ type: "checkpoint_request" }, SYNC_REPLY_MS); }

  #line(line: string): void {
    let frame: any;
    try { frame = JSON.parse(line); } catch { return; }
    switch (frame.type) {
      case "ready": this.emit("relay-ready"); return;
      case "reply": { const pending = this.#pending.get(frame.id); this.#pending.delete(frame.id); pending?.resolve(frame.body); return; }
      case "stdout": this.emit("stdout", Buffer.from(frame.data, "base64")); return;
      case "stderr": this.emit("stderr", Buffer.from(frame.data, "base64")); return;
      case "native_error": this.emit("stderr", Buffer.from("The engine reported a process error on the cloud computer.\n")); return;
      case "native_exit": this.#exit(Number.isInteger(frame.code) ? frame.code : null, typeof frame.signal === "string" ? frame.signal : null); return;
      case "file_begin":
        try { this.#receiver!.begin(frame.file); this.#skipping = false; }
        catch (error) { this.#skipping = true; this.conflicts.push(`${frame.file?.path}: ${(error as Error).message}`); this.emit("conflict", frame.file?.path, (error as Error).message); }
        return;
      case "file_chunk": if (!this.#skipping) try { this.#receiver!.chunk(Buffer.from(frame.data, "base64")); } catch (error) { this.#skipping = true; this.#receiver!.close(); this.conflicts.push((error as Error).message); } return;
      case "file_end": if (!this.#skipping) try { this.#receiver!.end(); } catch (error) { this.conflicts.push((error as Error).message); } this.#skipping = false; return;
      case "file_remove": try { this.#receiver!.remove(frame.file); } catch (error) { this.conflicts.push(`${frame.file?.path}: ${(error as Error).message}`); } return;
      case "checkpoint": this.#receiver?.resetBudget(); this.emit("checkpoint", frame.id); this.#send({ type: "ack", id: frame.id }); return;
      case "proxy_open": this.#openProxy(String(frame.id), String(frame.name)); return;
      case "proxy_stdin": this.#proxies.get(String(frame.id))?.stdin?.write(Buffer.from(frame.data, "base64")); return;
      case "proxy_end": this.#proxies.get(String(frame.id))?.stdin?.end(); return;
      case "proxy_close": { const proxy = this.#proxies.get(String(frame.id)); this.#proxies.delete(String(frame.id)); proxy?.kill(); return; }
      case "hook": void this.#runHook(String(frame.id), Number(frame.index) || 0, frame.payload); return;
      default: return;
    }
  }

  #openProxy(id: string, name: string): void {
    const spec = this.#launch.mcp[name];
    if (!spec) { this.#send({ type: "proxy_exit", id, code: 1 }); return; }
    const child = spawn(spec.command, spec.args ?? [], { cwd: this.#launch.cwd, env: { ...this.#launch.hookEnv, ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.#proxies.set(id, child);
    child.stdin.on("error", () => {});
    child.stdout.on("data", (bytes) => this.#send({ type: "proxy_stdout", id, data: Buffer.from(bytes).toString("base64") }));
    child.stderr.on("data", (bytes) => this.#send({ type: "proxy_stderr", id, data: Buffer.from(bytes).toString("base64") }));
    child.on("error", () => { this.#proxies.delete(id); this.#send({ type: "proxy_exit", id, code: 1 }); });
    child.on("close", (code) => { if (this.#proxies.get(id) === child) this.#proxies.delete(id); if (!this.#closed) this.#send({ type: "proxy_exit", id, code: code ?? 1 }); });
  }

  async #runHook(id: string, index: number, payload: unknown): Promise<void> {
    const command = this.#launch.hooks[index];
    if (!command) { this.#send({ type: "hook_result", id, body: { stdout: "", code: 0 } }); return; }
    const child = spawn("/bin/sh", ["-c", command], { cwd: this.#launch.cwd, env: this.#launch.hookEnv, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (bytes) => { if (stdout.length < 1024 * 1024) stdout += bytes; });
    child.stderr.on("data", (bytes) => { if (stderr.length < 64 * 1024) stderr += bytes; });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    const timer = setTimeout(() => child.kill("SIGKILL"), 25_000);
    const code = await new Promise<number>((resolve) => { child.on("close", (value) => resolve(value ?? 0)); child.on("error", () => resolve(0)); });
    clearTimeout(timer);
    if (!this.#closed) this.#send({ type: "hook_result", id, body: { stdout, stderr, code } });
  }

  #exit(code: number | null, signal: string | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.emit("native-exit", code, signal);
    this.#teardown();
  }

  #lost(why: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("link-closed");
    for (const pending of this.#pending.values()) pending.reject(new Error(`The cloud computer connection ended (${why}).`));
    this.#pending.clear();
    if (this.#started && !this.#exited) {
      this.emit("stderr", Buffer.from("The connection to the cloud computer ended during this turn. The engine there was stopped, and the turn was not run again.\n"));
      this.#exited = true;
      this.emit("native-exit", 1, null);
    }
    this.#teardown();
  }

  #teardown(): void {
    if (this.#pushTimer) clearInterval(this.#pushTimer);
    this.#pushTimer = null;
    for (const proxy of this.#proxies.values()) proxy.kill();
    this.#proxies.clear();
    this.#receiver?.close();
  }

  get launchSent(): boolean { return this.#launchSent; }
}

export class EngineProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number | undefined;
  placement: "pending" | "computer" | "home" = "pending";
  #local: ChildProcess | null = null;
  #remote: RemoteSession | null = null;
  #stopRequested = false;
  #closed: Promise<void>;
  #markClosed!: () => void;

  constructor(remote: RemoteSession, fallback: () => ChildProcess, onPlaced?: (where: "computer" | "home", why?: string) => void) {
    super();
    this.#closed = new Promise((resolve) => { this.#markClosed = resolve; });
    this.stdin.on("error", () => {});
    this.stdin.pause();
    this.#remote = remote;
    remote.on("diagnostic", (text: string) => { if (!this.stderr.writableEnded) this.stderr.write(`[cloud computer] ${text}`); });
    void remote.start().then(() => {
      this.placement = "computer";
      onPlaced?.("computer");
      remote.on("stdout", (bytes: Buffer) => { if (!this.stdout.writableEnded) this.stdout.write(bytes); });
      remote.on("stderr", (bytes: Buffer) => { if (!this.stderr.writableEnded) this.stderr.write(bytes); });
      remote.once("native-exit", (code: number | null, signal: string | null) => this.#finish(code, signal as NodeJS.Signals | null));
      this.stdin.on("data", (bytes: Buffer) => remote.write(Buffer.from(bytes)));
      this.stdin.on("end", () => remote.end());
      this.stdin.resume();
      if (this.#stopRequested) remote.stop();
    }, (error: Error) => {
      if (error instanceof NotDispatched && !remote.launchSent || (error instanceof NotDispatched && error.refused === "spawn_failed")) {
        remote.close();
        this.#remote = null;
        if (this.#stopRequested) { this.placement = "home"; this.#finish(null, "SIGTERM"); return; }
        this.placement = "home";
        onPlaced?.("home", error.message);
        this.#startLocal(fallback);
        return;
      }
      this.placement = "computer";
      onPlaced?.("computer", error.message);
      remote.close();
      this.stderr.write(`${error.message}\n`);
      this.#finish(1, null);
    });
  }

  #startLocal(fallback: () => ChildProcess): void {
    let child: ChildProcess;
    try { child = fallback(); }
    catch (error) { queueMicrotask(() => { this.emit("error", error); this.#finish(null, null); }); return; }
    this.#local = child;
    this.pid = child.pid;
    child.stdout!.pipe(this.stdout);
    child.stderr!.pipe(this.stderr);
    child.on("error", (error) => this.emit("error", error));
    child.on("close", (code, signal) => this.#finish(code, signal));
    this.stdin.pipe(child.stdin!);
    this.stdin.resume();
  }

  #finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    if (code === null && signal === null) this.exitCode = 1;
    this.#remote?.close();
    const done = () => { this.emit("exit", this.exitCode, signal); this.emit("close", this.exitCode, signal); this.#markClosed(); };
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
    let pending = 2;
    const settle = () => { if (--pending === 0) setImmediate(done); };
    for (const stream of [this.stdout, this.stderr]) {
      let counted = false;
      const ended = () => { if (counted) return; counted = true; settle(); };
      if (stream.readableEnded || stream.destroyed) ended();
      else { stream.once("end", ended); stream.once("close", ended); if (stream.listenerCount("data") === 0 && !stream.readableFlowing) stream.resume(); }
    }
  }

  async stopTree(timeoutMs: number, stopLocal: (child: ChildProcess, timeoutMs: number) => Promise<boolean>): Promise<boolean> {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.#stopRequested = true;
    if (this.#local) return stopLocal(this.#local, timeoutMs);
    this.#remote?.stop();
    const ended = await Promise.race([this.#closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), Math.max(timeoutMs, 0) + 8_000).unref())]);
    if (!ended) { this.#remote?.close(); return Promise.race([this.#closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 6_000).unref())]); }
    return true;
  }

  kill(): boolean { void this.stopTree(5_000, async (child) => child.kill("SIGTERM")); return true; }
}
