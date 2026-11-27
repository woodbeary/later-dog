import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import WebSocket from "ws";
import { claudeProjectSlug } from "./claude-project.ts";
import { computersConnection, computersKey } from "./cloud-computers.ts";
import { engineScripts } from "./engine-computer.ts";
import { notePlacement, REMOTE_ENGINE_BASE, REMOTE_ENGINES_FILE, type ClaudeRemotePlan, type EngineOpener } from "./engine-placement.ts";
import type { EngineLink } from "./engine-remote.ts";

export const POOL_RELAY = `${REMOTE_ENGINE_BASE}/cli/pool-relay`;
export const POOL_ROOT = "/pool";
export const POOL_SHELL_DIR = "/usr/local/lib/laterdog-pool/bin";
export const POOL_COMMAND_MS = 60_000;
const OPEN_TIMEOUT_MS = 120_000;
const ATTACH_TIMEOUT_MS = 20_000;
const CLAUDE_CLI = "@anthropic-ai/claude-code";

export function poolChosen(dataDir: string, botId: string): boolean {
  try {
    const pool = (JSON.parse(readFileSync(join(dataDir, REMOTE_ENGINES_FILE), "utf8")) as { pool?: { enabled?: unknown; bots?: unknown } }).pool;
    if (!pool || pool.enabled !== true) return false;
    return !Array.isArray(pool.bots) || pool.bots.includes(botId);
  } catch { return false; }
}

export function poolFits(plan: ClaudeRemotePlan): boolean {
  return !plan.guestRuntime && plan.cli.name === CLAUDE_CLI && plan.launch.cli.startsWith(`${REMOTE_ENGINE_BASE}/cli/`) && !plan.launch.ephemeralCodexHome;
}

export function poolChat(botId: string, threadId: string): string {
  return `c${createHash("sha256").update(`${botId}\0${threadId}`).digest("hex").slice(0, 32)}`;
}

export interface PoolOpened { status: number; slot?: number; state?: string; refusal?: string }
export interface PoolService {
  open(chat: string, env: Record<string, string>, signal?: AbortSignal): Promise<PoolOpened>;
  close(chat: string): Promise<void>;
  stream(chat: string, signal?: AbortSignal): Promise<WebSocket>;
}

export class PoolNotWarm extends Error {}

export function poolService(): PoolService | null {
  const connection = computersConnection();
  if (!connection || connection.source === "trial") return null;
  const key = computersKey(connection);
  const base = `${connection.api.replace(/\/v1$/, "")}/v1/pool/engines`;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" };
  return {
    async open(chat, env, signal) {
      const timeout = AbortSignal.timeout(OPEN_TIMEOUT_MS);
      const response = await fetch(base, { method: "POST", headers, body: JSON.stringify({ chat, command: [POOL_RELAY], env }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = await response.json().catch(() => null) as { engine?: { slot?: unknown }; state?: unknown; error?: { code?: unknown; message?: unknown } } | null;
      const slot = typeof body?.engine?.slot === "number" ? body.engine.slot : undefined;
      return { status: response.status, slot, state: typeof body?.state === "string" ? body.state : undefined,
        refusal: response.ok ? undefined : `${String(body?.error?.code ?? response.status)}: ${String(body?.error?.message ?? "the pool refused the engine")}` };
    },
    async close(chat) {
      await fetch(`${base}/${chat}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) }).then((response) => response.body?.cancel(), () => undefined);
    },
    stream(chat, signal) {
      const url = new URL(`${base}/${chat}/stream`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return attachPool(new WebSocket(url, { headers: { authorization: `Bearer ${key}` }, handshakeTimeout: 15_000, followRedirects: false, maxPayload: 16 * 1024 * 1024 }), signal);
    },
  };
}

export function attachPool(socket: WebSocket, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      socket.off("message", first);
      if (!error) return resolve(socket);
      socket.terminate();
      reject(error);
    };
    const aborted = () => finish(new Error("The pool engine was no longer wanted."));
    const timer = setTimeout(() => finish(new Error("The pool engine stream did not attach in time.")), ATTACH_TIMEOUT_MS);
    const first = (data: WebSocket.RawData, binary: boolean) => {
      if (binary) return;
      try { if ((JSON.parse(String(data)) as { channel?: string }).channel === "attached") finish(); } catch {}
    };
    signal?.addEventListener("abort", aborted, { once: true });
    socket.on("message", first);
    socket.once("unexpected-response", (_request, response) => {
      response.destroy();
      finish(response.statusCode === 404 ? new PoolNotWarm("The pool closed the engine before it attached.") : new Error(`The pool stream was refused (${response.statusCode}).`));
    });
    socket.once("error", () => finish(new Error("The pool stream could not be opened.")));
    socket.once("close", () => finish(new PoolNotWarm("The pool stream closed before it attached.")));
  });
}

export function poolLink(socket: WebSocket, stop: () => void): EngineLink {
  const link = new EventEmitter() as EngineLink;
  let closed = false;
  let partial: Buffer = Buffer.alloc(0);
  const waiting: string[] = [];
  const deliver = (line: string) => { if (link.listenerCount("line")) link.emit("line", line); else waiting.push(line); };
  link.on("newListener", (name) => { if (name === "line") queueMicrotask(() => { for (const line of waiting.splice(0)) link.emit("line", line); }); });
  const close = (why: string) => {
    if (closed) return;
    closed = true;
    stop();
    link.emit("close", why);
  };
  socket.on("message", (data: WebSocket.RawData, binary: boolean) => {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (!binary) {
      let frame: { channel?: string; code?: unknown; reason?: unknown; message?: unknown };
      try { frame = JSON.parse(bytes.toString("utf8")); } catch { return; }
      if (frame.channel === "exit") close(`pool relay exited ${String(frame.code)}`);
      else if (frame.channel === "closed") close(`pool closed the engine: ${String(frame.reason)}`);
      else if (frame.channel === "error") link.emit("diagnostic", String(frame.message ?? "pool stream error"));
      return;
    }
    const body = bytes.subarray(1);
    if (bytes[0] === 2) { link.emit("diagnostic", body.toString("utf8")); return; }
    partial = partial.length ? Buffer.concat([partial, body]) : body;
    let newline: number;
    while ((newline = partial.indexOf(10)) >= 0) {
      deliver(partial.subarray(0, newline).toString("utf8"));
      partial = partial.subarray(newline + 1);
    }
  });
  socket.on("close", () => close("pool stream closed"));
  socket.on("error", () => close("pool stream failed"));
  link.send = (line) => { if (!closed) socket.send(Buffer.from(`${line}\n`)); };
  link.close = () => {
    if (closed) return;
    try { socket.close(); } catch {}
    close("closed by the home");
  };
  return link;
}

let packedRelay: { key: string; value: string } | null = null;
export function relayFiles(): string {
  const scripts = engineScripts();
  if (packedRelay?.key === scripts.dir) return packedRelay.value;
  const files = Object.fromEntries(scripts.files.map((file) => [file.name.replace(/\.js$/, ".mjs"), file.bytes.toString("base64")]));
  packedRelay = { key: scripts.dir, value: gzipSync(JSON.stringify(files)).toString("base64") };
  return packedRelay.value;
}

export interface PoolLayout { root: string; engineBase: string }
const POOL_LAYOUT: PoolLayout = { root: POOL_ROOT, engineBase: REMOTE_ENGINE_BASE };

export function poolLaunch(plan: ClaudeRemotePlan, slot: number, computerProxy: string, layout: PoolLayout = POOL_LAYOUT): void {
  const base = layout.engineBase;
  const scratch = `${layout.root}/slot-${slot}/tmp`;
  const testRoot = `${scratch}/m`;
  const engineBase = `${scratch}/e`;
  const launch = plan.launch;
  const rebase = (path: string) => path.startsWith(`${base}/`) ? `${engineBase}${path.slice(base.length)}` : path;
  const swap = (text: string) => text.split(computerProxy).join(`${scratch}/relay/engine-proxy.mjs`).split(`${base}/run/`).join(`${engineBase}/run/`);
  for (const name of readdirSync(plan.stagingDir)) {
    const file = join(plan.stagingDir, name);
    if (!statSync(file).isFile()) continue;
    const text = readFileSync(file, "utf8");
    const swapped = swap(text);
    if (swapped !== text) writeFileSync(file, swapped, { mode: 0o600 });
  }
  launch.socketPath = rebase(launch.socketPath);
  launch.stateFile = rebase(launch.stateFile);
  launch.lockFile = rebase(launch.lockFile);
  delete launch.workFolders;
  const configDir = launch.roots.find((root) => root.id === "account")?.path;
  const projects = configDir ? `${testRoot}${configDir}/projects/${claudeProjectSlug(`${testRoot}${launch.cwd}`)}` : null;
  launch.roots = launch.roots.filter((root) => root.id !== "bot" && root.id !== "bot-workspace").map((root) => {
    if (root.id === "workspace") return { ...root, files: [], streamedTree: false };
    if (root.id === "session" && projects) return { ...root, remotePath: projects };
    if (root.id === "session-extra" && projects) return { ...root, remotePath: `${projects}/${basename(root.path)}` };
    return root;
  });
  launch.outputIds = launch.outputIds.filter((id) => launch.roots.some((root) => root.id === id) && id !== "workspace");
  launch.env = {
    ...launch.env,
    HOME: `${layout.root}/slot-${slot}/home`,
    TMPDIR: scratch,
    SHELL: `${POOL_SHELL_DIR}/bash`,
    PATH: `${POOL_SHELL_DIR}:${launch.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    BASH_DEFAULT_TIMEOUT_MS: String(POOL_COMMAND_MS),
    BASH_MAX_TIMEOUT_MS: String(POOL_COMMAND_MS),
  };
  mkdirSync(plan.stagingDir, { recursive: true, mode: 0o700 });
}

export async function openOnPool(pool: PoolService, botId: string, plan: ClaudeRemotePlan, computerProxy: string, signal?: AbortSignal, layout: PoolLayout = POOL_LAYOUT): Promise<{ link: EngineLink; state: string; slot: number }> {
  const chat = poolChat(botId, plan.threadId);
  const env = { LATERDOG_ENGINE_FILES: relayFiles() };
  for (let attempt = 0; ; attempt++) {
    let opened = await pool.open(chat, env, signal);
    if (opened.status === 200) {
      await pool.close(chat);
      opened = await pool.open(chat, env, signal);
    }
    if (opened.status !== 201 || opened.slot === undefined) throw new Error(`The pool did not start a fresh engine (${opened.refusal ?? `${opened.status} ${opened.state ?? ""}`.trim()}).`);
    try {
      const socket = await pool.stream(chat, signal);
      poolLaunch(plan, opened.slot, computerProxy, layout);
      return { link: poolLink(socket, () => { void pool.close(chat); }), state: opened.state ?? "cold", slot: opened.slot };
    } catch (error) {
      if (attempt === 0 && error instanceof PoolNotWarm && !signal?.aborted) continue;
      await pool.close(chat);
      throw error;
    }
  }
}

export function poolEngineOpener(computer: EngineOpener, dataDir: string, service: () => PoolService | null = poolService): EngineOpener {
  return {
    get proxyPath() { return computer.proxyPath; },
    get guestProvider() { return computer.guestProvider; },
    get remoteBase() { return computer.remoteBase; },
    openBudgetMs: computer.openBudgetMs,
    async open(botId, plan, signal) {
      if (!poolChosen(dataDir, botId) || !poolFits(plan)) return computer.open(botId, plan, signal);
      const who = `${botId.slice(0, 8)} ${plan.threadId.slice(0, 8)}`;
      const began = Date.now();
      try {
        const pool = service();
        if (!pool) throw new Error("this home has no computers service for the pool");
        const opened = await openOnPool(pool, botId, plan, computer.proxyPath, signal);
        notePlacement(dataDir, `[pool] ${who} engine opened on pool slot ${opened.slot} in ${Date.now() - began} ms`);
        return opened.link;
      } catch (error) {
        if (signal?.aborted) throw error;
        notePlacement(dataDir, `[pool] ${who} falls back to the dog's computer after ${Date.now() - began} ms: ${error instanceof Error ? error.message : String(error)}`);
        return computer.open(botId, plan, signal);
      }
    },
  };
}
