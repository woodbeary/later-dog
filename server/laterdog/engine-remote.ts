import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { ENGINE_FRAME_BYTES, ENGINE_WINDOW_BYTES, EngineFileReceiver, sameEngineFile, streamedTree, workspaceRecovery, decodeEngineChunk, engineFileChunks, engineFileKey, inventoryWork, runFileWork, transcriptPrefixWork, selectEngineTranscript, selectedTranscript, type EngineFile, type EngineFileRoot } from "./engine-files.ts";
import { createHash } from "node:crypto";

export interface EngineLink extends EventEmitter {
  opening?: boolean;
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
  requireCompleteCheckpoint?: boolean;
  acknowledgedInput?: boolean;
  ephemeralCodexHome?: string;
  mcp: Record<string, StdioSpec>;
  hooks: string[];
  hookEnv: Record<string, string>;
  proxyEnv?: Record<string, string>;
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
  #incoming: Promise<void> = Promise.resolve();
  #written: Promise<void> = Promise.resolve();
  #fileAbort = new AbortController();
  #onFileProgress = () => { this.checkpointProgressAt = Date.now(); };
  #closed = false;
  #launchSent = false;
  #started = false;
  #exited = false;
  exitConfirmed = false;
  checkpointProgressAt = 0;
  #receiver: EngineFileReceiver | null = null;
  #skipping = false;
  #fileError: string | null = null;
  #pendingFileBytes = 0;
  #inventory: { resident: EngineFile[]; previous: EngineFile[] } | null = null;
  #proxies = new Map<string, ChildProcess>();
  #pushed = new Map<string, string>();
  #pushTimer: NodeJS.Timeout | null = null;
  conflicts: string[] = [];

  constructor(link: EngineLink, launch: RemoteLaunch) {
    super();
    this.#link = link;
    this.#launch = launch;
    this.#ready = new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        link.off("open", arm);
        this.off("relay-ready", onReady);
        link.off("close", onClosed);
      };
      const arm = () => {
        timer = setTimeout(() => {
          cleanup();
          reject(new NotDispatched("The cloud computer's engine relay did not answer."));
        }, HANDSHAKE_MS);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onClosed = (why: string) => {
        cleanup();
        reject(new NotDispatched(link.opening && why ? why : "The cloud computer's engine relay closed before it was ready."));
      };
      if (link.opening) link.once("open", arm); else arm();
      this.once("relay-ready", onReady);
      link.once("close", onClosed);
    });
    this.#ready.catch(() => {});
    link.on("line", (line: string) => {
      this.#incoming = this.#incoming.then(() => this.#line(line)).catch(() => { this.#lost("invalid engine transfer"); this.#link.close(); });
    });
    link.on("diagnostic", (text: string) => this.emit("diagnostic", text));
    link.on("close", (why: string) => { this.#fileAbort.abort(); void this.#incoming.then(() => this.#lost(why)); });
  }

  get started(): boolean { return this.#started; }

  #send(frame: unknown): void { this.#link.send(JSON.stringify(frame)); }
  #request(frame: Record<string, unknown>, timeoutMs: number, trackCheckpoint = false): Promise<any> {
    if (this.#closed) return Promise.reject(new Error("The cloud computer connection is closed."));
    const id = ++this.#sequence;
    const began = Date.now();
    return new Promise((resolve, reject) => {
      const expire = () => {
        const remaining = trackCheckpoint ? Math.max(began, this.checkpointProgressAt) + timeoutMs - Date.now() : 0;
        if (remaining > 0) { timer = setTimeout(expire, remaining); return; }
        this.#pending.delete(id);
        reject(new Error(`The engine relay did not answer ${String(frame.type)}.`));
      };
      let timer = setTimeout(expire, timeoutMs);
      this.#pending.set(id, { resolve: (body) => { clearTimeout(timer); resolve(body); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.#send({ ...frame, id });
    });
  }
  #sendFile(root: string, path: string, bytes: Buffer, mode: number): void {
    const hash = createHash("sha256").update(bytes).digest("hex");
    this.#send({ type: "file_begin", file: { root, path, hash, size: bytes.length, mode } });
    for (let offset = 0; offset < bytes.length; offset += ENGINE_FRAME_BYTES) this.#send({ type: "file_chunk", data: bytes.subarray(offset, offset + ENGINE_FRAME_BYTES).toString("base64") });
    this.#send({ type: "file_end" });
  }
  async #sendWorkingFile(root: EngineFileRoot, file: EngineFile, before?: EngineFile): Promise<void> {
    const prefix = await runFileWork(transcriptPrefixWork(root, file, before), this.#fileAbort.signal);
    const begin = { type: "file_begin", prefix, file: { ...file, mode: root.readOnly ? (file.mode & 0o444) | 0o400 : file.mode } };
    this.#pendingFileBytes += 256 + Buffer.byteLength(file.path);
    if (selectedTranscript(root, file.path) || (streamedTree(root) && file.size >= 8 * ENGINE_WINDOW_BYTES)) {
      const reply = await this.#request(begin, SYNC_REPLY_MS);
      if (!reply?.accepted) throw new Error(reply?.error ?? "The computer could not accept its native transcript");
    } else this.#send(begin);
    for (const bytes of engineFileChunks(root, file.path, ENGINE_FRAME_BYTES, prefix?.size, file.size)) {
      this.#send({ type: "file_chunk", data: bytes.toString("base64") });
      this.#pendingFileBytes += bytes.length;
      if (this.#pendingFileBytes >= ENGINE_WINDOW_BYTES) {
        await this.#request({ type: "file_window" }, HANDSHAKE_MS);
        this.#pendingFileBytes = 0;
        this.#onFileProgress();
      }
    }
    this.#send({ type: "file_end" });
    if (this.#pendingFileBytes >= ENGINE_WINDOW_BYTES) {
      await this.#request({ type: "file_window" }, HANDSHAKE_MS);
      this.#pendingFileBytes = 0;
    }
    this.#onFileProgress();
  }

  #pushScoped(remote: Map<string, string>, files = this.#launch.pushes?.() ?? []): void {
    for (const file of files) {
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
    let configured: { files: EngineFile[]; trees?: string[]; refused?: string; transcripts?: { root: string; path: string; before: EngineFile | null }[] };
    let home: EngineFile[];
    const pushedRoots = new Set(launch.roots.filter(root => root.pushOnly).map(root => root.id));
    const initialPush = launch.pushes?.() ?? [];
    for (const id of pushedRoots) {
      if (!initialPush.some(file => file.root === id)) throw new NotDispatched("The selected sign-in is unavailable on the home.");
    }
    try {
      home = await runFileWork(inventoryWork(launch.roots.filter((root) => !pushedRoots.has(root.id))), this.#fileAbort.signal, this.#onFileProgress);
    } catch (error) {
      throw new NotDispatched(`The working files cannot move to the cloud computer: ${(error as Error).message}`);
    }
    try {
      this.#inventory = { resident: [], previous: [] };
      configured = await this.#request({ type: "configure", stateFile: launch.stateFile, lockFile: launch.lockFile, ephemeralCodexHome: launch.ephemeralCodexHome, roots: launch.roots.map((root) => ({ ...root, writable: true })), outputIds: launch.outputIds, names: Object.keys(launch.mcp) }, SYNC_REPLY_MS, true);
    } catch (error) { throw new NotDispatched((error as Error).message); }
    if (configured.refused === "busy") throw new Error("This chat's engine is still running on the cloud computer; it was not started a second time.");
    const received = this.#inventory;
    this.#inventory = null;
    const trees = launch.roots.filter(streamedTree);
    if (trees.some(root => !configured.trees?.includes(root.id))) throw new NotDispatched("The computer could not verify its working folder checkpoint.");
    for (const file of received.resident) configured.files.push(file);
    const remote = new Map(configured.files.map((file) => [engineFileKey(file), file]));
    const outputRoots = launch.roots.filter(root => launch.outputIds.includes(root.id));
    this.#receiver = new EngineFileReceiver(outputRoots, home.filter(file => launch.outputIds.includes(file.root)));
    for (const tree of trees) {
      const changes = workspaceRecovery(tree.id, home, configured.files, received.previous);
      for (let i = 0; i < changes.length; i += 64) {
        const files = changes.slice(i, i + 64);
        const result = await this.#request({ type: "recover_workspace", files }, SYNC_REPLY_MS, true);
        if (!result?.recovered || files.some(file => this.#receiver!.baseline.get(engineFileKey(file))?.hash !== file.hash)) throw new Error("The computer's newer working files could not be recovered.");
      }
      if (changes.length) home = [...home.filter(file => file.root !== tree.id), ...[...this.#receiver.baseline.values()].filter(file => file.root === tree.id)];
    }
    for (const receipt of configured.transcripts ?? []) {
      const root = outputRoots.find(root => root.id === receipt.root);
      if (!root || !selectedTranscript(root, receipt.path)) throw new Error("Unexpected native transcript recovery path");
      const key = engineFileKey(receipt);
      const local = this.#receiver.baseline.get(key);
      const guest = remote.get(key);
      if (local?.hash === guest?.hash || guest?.hash === receipt.before?.hash) continue;
      if (local?.hash !== receipt.before?.hash) throw new Error("Native transcript changed on both the home and computer. Both copies were preserved.");
      const recovery = await this.#request({ type: "recover_transcript", root: root.id, path: receipt.path, hash: guest?.hash }, SYNC_REPLY_MS, true);
      if (!recovery?.recovered || this.#receiver.baseline.get(key)?.hash !== guest?.hash) throw new Error("The newer computer transcript could not be recovered. Both copies were preserved.");
      home = home.filter(file => engineFileKey(file) !== key);
      if (guest) home.push(guest);
    }
    const present = new Set(home.map(engineFileKey));
    try {
      for (const file of home) {
        const before = remote.get(engineFileKey(file));
        const root = launch.roots.find((entry) => entry.id === file.root)!;
        if (streamedTree(root) ? sameEngineFile(before, file) : before?.hash === file.hash) continue;
        await this.#sendWorkingFile(root, file, before);
      }
      for (const file of configured.files) if (!present.has(engineFileKey(file)) && !pushedRoots.has(file.root)) this.#send({ type: "file_remove", file });
      this.#pushScoped(new Map([...remote].map(([key, file]) => [key, file.hash])), initialPush);
      await this.#request({ type: "prepared" }, SYNC_REPLY_MS);
    } catch (error) { throw new NotDispatched((error as Error).message); }
    if (this.#closed) throw new NotDispatched("The cloud computer's connection closed before launch.");
    this.#launchSent = true;
    let body: any;
    try {
      body = await this.#request({ type: "launch", cli: launch.cli, args: launch.args, cwd: launch.cwd, env: launch.env,
        socketPath: launch.socketPath, stateFile: launch.stateFile, lockFile: launch.lockFile, ephemeralCodexHome: launch.ephemeralCodexHome }, HANDSHAKE_MS, true);
    } catch (error) {
      throw new Error(`The cloud computer did not confirm the engine started: ${(error as Error).message}`);
    }
    if (body?.refused === "spawn_failed") throw new NotDispatched("The engine could not start on the cloud computer.", "spawn_failed");
    if (body?.refused === "busy") throw new Error("This chat's engine is still running on the cloud computer; it was not started a second time.");
    if (!body?.started) throw new Error("The cloud computer gave an unexpected answer to the engine launch.");
    if (this.#exited) return;
    if (this.#closed || this.#fileAbort.signal.aborted) throw new Error("The connection to the cloud computer ended before the engine could be used.");
    this.#started = true;
    this.#pushTimer = setInterval(() => this.#pushScoped(new Map()), launch.pushEveryMs ?? PUSH_EVERY_MS);
    this.#pushTimer.unref();
  }

  write(bytes: Buffer): void {
    if (!this.#started || this.#closed) return;
    if (!this.#launch.acknowledgedInput) { this.#send({ type: "stdin", data: bytes.toString("base64") }); return; }
    this.#written = this.#written.then(async () => {
      for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
        await this.#request({ type: "stdin", data: bytes.subarray(offset, offset + 256 * 1024).toString("base64") }, SYNC_REPLY_MS);
      }
    }).catch(() => { this.#lost("engine input interrupted"); this.#link.close(); });
  }
  end(): void {
    void this.#written.then(() => { if (this.#started && !this.#closed) this.#send({ type: "end" }); });
  }
  stop(): void { if (!this.#closed) this.#send({ type: "stop" }); }
  close(): void { this.#link.close(); }
  async selectTranscript(id: string, name: string): Promise<boolean> {
    if (!this.#started) return false;
    const root = this.#receiver?.roots.get(id);
    selectEngineTranscript(root, name);
    const reply = await this.#request({ type: "select_transcript", root: id, path: name }, HANDSHAKE_MS);
    return reply?.selected === true;
  }

  checkpoint(): Promise<unknown> { return this.#request({ type: "checkpoint_request" }, SYNC_REPLY_MS, true); }

  async #line(line: string): Promise<void> {
    if (this.#closed) return;
    let frame: any;
    try { frame = JSON.parse(line); } catch { return; }
    switch (frame.type) {
      case "file_progress": this.#onFileProgress(); return;
      case "inventory_page": {
        if (!this.#inventory || (frame.kind !== "resident" && frame.kind !== "previous") || !Array.isArray(frame.files) || frame.files.length > 128) throw new Error("Unexpected engine inventory response");
        const files = frame.kind === "resident" ? this.#inventory.resident : this.#inventory.previous;
        files.push(...frame.files);
        this.#onFileProgress();
        return;
      }
      case "ready": this.emit("relay-ready"); return;
      case "reply": { const pending = this.#pending.get(frame.id); this.#pending.delete(frame.id); pending?.resolve(frame.body); return; }
      case "stdout": this.emit("stdout", Buffer.from(frame.data, "base64")); return;
      case "stderr": this.emit("stderr", Buffer.from(frame.data, "base64")); return;
      case "native_error": this.emit("stderr", Buffer.from("The engine reported a process error on the cloud computer.\n")); return;
      case "native_exit": this.#exit(Number.isInteger(frame.code) ? frame.code : null, typeof frame.signal === "string" ? frame.signal : null); return;
      case "file_begin":
        this.#fileError = null;
        try { await runFileWork(this.#receiver!.beginWork(frame.file, frame.prefix), this.#fileAbort.signal, this.#onFileProgress); this.#skipping = false; }
        catch (error) { this.#skipping = true; this.#fileError = (error as Error).message; this.conflicts.push(`${frame.file?.path}: ${this.#fileError}`); this.emit("conflict", frame.file?.path, this.#fileError); }
        return;
      case "file_chunk": if (!this.#skipping) try { this.#receiver!.chunk(decodeEngineChunk(frame.data)); this.#onFileProgress(); } catch (error) { this.#skipping = true; this.#receiver!.close(); this.#fileError = (error as Error).message; this.conflicts.push(this.#fileError); } return;
      case "file_end": if (!this.#skipping) try { await runFileWork(this.#receiver!.endWork(), this.#fileAbort.signal, this.#onFileProgress); } catch (error) { this.#fileError = (error as Error).message; this.conflicts.push(this.#fileError); } this.#skipping = false; return;
      case "file_window": this.#send({ type: "ack", id: frame.id, ...(this.#fileError && frame.required ? { error: this.#fileError } : {}) }); return;
      case "file_remove": this.#fileError = null; try { await runFileWork(this.#receiver!.removeWork(frame.file), this.#fileAbort.signal, this.#onFileProgress); } catch (error) { this.#fileError = (error as Error).message; this.conflicts.push(`${frame.file?.path}: ${(error as Error).message}`); } return;
      case "checkpoint":
        if (this.#launch.requireCompleteCheckpoint && this.conflicts.length) {
          this.emit("diagnostic", "The cloud computer's checkpoint could not be committed because files conflicted or failed to transfer.\n");
          this.#lost("incomplete checkpoint");
          this.#link.close();
          return;
        }
        this.#receiver?.resetBudget();
        this.emit("checkpoint", frame.id);
        this.#send({ type: "ack", id: frame.id });
        return;
      case "proxy_open": this.#openProxy(String(frame.id), String(frame.name)); return;
      case "proxy_stdin": this.#proxies.get(String(frame.id))?.stdin?.write(Buffer.from(frame.data, "base64")); return;
      case "proxy_end": this.#proxies.get(String(frame.id))?.stdin?.end(); return;
      case "proxy_close": { const proxy = this.#proxies.get(String(frame.id)); this.#proxies.delete(String(frame.id)); proxy?.kill(); return; }
      case "hook": void this.#runHook(String(frame.id), Number(frame.index) || 0, frame.payload); return;
      default: return;
    }
  }

  #openProxy(id: string, name: string): void {
    const spec = Object.hasOwn(this.#launch.mcp, name) ? this.#launch.mcp[name] : undefined;
    if (!spec) { this.#send({ type: "proxy_exit", id, code: 1 }); return; }
    const child = spawn(spec.command, spec.args ?? [], { cwd: this.#launch.cwd, env: { ...(this.#launch.proxyEnv ?? this.#launch.hookEnv), ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
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
    this.exitConfirmed = true;
    this.emit("native-exit", code, signal);
    this.#teardown();
  }

  #lost(why: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fileAbort.abort();
    this.emit("link-closed", why);
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
  notDispatched = false;
  placement: "pending" | "computer" | "home" = "pending";
  #local: ChildProcess | null = null;
  #remote: RemoteSession | null = null;
  #stopRequested = false;
  #closed: Promise<void>;
  #markClosed!: () => void;

  get preparationProgressAt(): number { return this.#remote?.checkpointProgressAt ?? 0; }

  constructor(remote: RemoteSession, fallback?: () => ChildProcess, onPlaced?: (where: "computer" | "home", why?: string) => void) {
    super();
    this.#closed = new Promise((resolve) => { this.#markClosed = resolve; });
    this.stdin.on("error", () => {});
    this.stdin.pause();
    this.#remote = remote;
    remote.on("diagnostic", (text: string) => { if (!this.stderr.writableEnded) this.stderr.write(`[cloud computer] ${text}`); });
    remote.on("stdout", (bytes: Buffer) => { if (!this.stdout.writableEnded) this.stdout.write(bytes); });
    remote.on("stderr", (bytes: Buffer) => { if (!this.stderr.writableEnded) this.stderr.write(bytes); });
    let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    remote.once("native-exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.placement === "computer") this.#finish(code, signal);
      else earlyExit = { code, signal };
    });
    void remote.start().then(() => {
      this.placement = "computer";
      onPlaced?.("computer");
      if (earlyExit) { this.#finish(earlyExit.code, earlyExit.signal); return; }
      this.stdin.on("data", (bytes: Buffer) => remote.write(Buffer.from(bytes)));
      this.stdin.on("end", () => remote.end());
      this.stdin.resume();
      if (this.#stopRequested) remote.stop();
    }, (error: Error) => {
      if (error instanceof NotDispatched && !remote.launchSent || (error instanceof NotDispatched && error.refused === "spawn_failed")) {
        this.notDispatched = true;
        remote.close();
        this.#remote = null;
        if (this.#stopRequested) { if (fallback) this.placement = "home"; this.#finish(null, "SIGTERM"); return; }
        if (!fallback) { this.stderr.write(`${error.message}\n`); this.#finish(1, null); return; }
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

  async selectTranscript(id: string, name: string): Promise<boolean> {
    return this.placement === "computer" && this.#remote !== null && this.#remote.selectTranscript(id, name);
  }

  async stopTree(timeoutMs: number, stopLocal: (child: ChildProcess, timeoutMs: number) => Promise<boolean>): Promise<boolean> {
    if (this.exitCode !== null || this.signalCode !== null) return !this.#remote || this.#remote.exitConfirmed;
    this.#stopRequested = true;
    if (this.#local) return stopLocal(this.#local, timeoutMs);
    if (this.#remote && !this.#remote.launchSent) {
      this.#remote.close();
      await Promise.race([this.#closed, new Promise<void>((resolve) => setTimeout(resolve, 6_000).unref())]);
      return !this.#remote || this.#remote.exitConfirmed;
    }
    this.#remote?.stop();
    const stoppedAt = Date.now();
    const grace = Math.max(timeoutMs, 0) + 8_000;
    let ended = false;
    let remaining = grace;
    while (!ended && remaining > 0) {
      ended = await Promise.race([this.#closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining).unref())]);
      const lastProgress = Math.max(stoppedAt, this.#remote?.checkpointProgressAt ?? 0);
      remaining = lastProgress + grace - Date.now();
    }
    if (!ended) {
      this.#remote?.close();
      await Promise.race([this.#closed, new Promise<void>((resolve) => setTimeout(resolve, 6_000).unref())]);
    }
    return !this.#remote || this.#remote.exitConfirmed;
  }

  kill(): boolean { void this.stopTree(5_000, async (child) => child.kill("SIGTERM")); return true; }
}
