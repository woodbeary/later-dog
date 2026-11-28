import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import WebSocket from "ws";
import { claudeProjectSlug } from "./claude-project.ts";
import { computersConnection, computersKey, savedTrial } from "./cloud-computers.ts";
import { engineScripts } from "./engine-computer.ts";
import { notePlacement, REMOTE_ENGINE_BASE, REMOTE_ENGINES_FILE, type ClaudeRemotePlan, type EngineOpener } from "./engine-placement.ts";
import type { EngineLink } from "./engine-remote.ts";

export const POOL_RELAY = `${REMOTE_ENGINE_BASE}/cli/pool-relay`;
export const POOL_ROOT = "/pool";
export const POOL_SHELL_DIR = "/usr/local/lib/laterdog-pool/bin";
export const POOL_COMMAND_MS = 60_000;
const OPEN_TIMEOUT_MS = 120_000;
const ATTACH_TIMEOUT_MS = 20_000;
export const POOL_PING_MS = 15_000;
export const POOL_SILENT_MS = 45_000;
export const POOL_EXIT_LINE = JSON.stringify({ type: "native_exit", code: null, signal: "SIGKILL" });
const CLAUDE_CLI = "@anthropic-ai/claude-code";
export const POOL_AVOID_MS = 10 * 60_000;
export const POOL_LOST_REASON = "engine machine lost";
export const POOL_WARM_MS = 10 * 60_000;
const poolThreads = new Set<string>();
export const onPool = (threadId: string): boolean => poolThreads.has(threadId);
export const POOL_NOTE = "\n\nWhere you work: this chat runs on a shared engine machine. Your built-in file, search and shell tools act on a scratch folder there. Scratch is not your working folder: it is not saved and can be cleared at any time, so never tell the person a file you made in scratch is saved. For your own files use the folder tool (list, read, search, write, edit, delete); if it says a change was not saved, tell the person it was not saved. For builds, tests, installs and long or heavy commands use run_on_computer.\n";
const poolLosses = new Map<string, { at: number; taken: boolean; memory: boolean; avoid: boolean }>();
const CLEAN_CLOSES = ["closed by the home", "pool relay exited 0", "pool closed the engine: idle", "pool closed the engine: closed"];
const MEMORY_CLOSE = "pool closed the engine: memory";

export function notePoolLoss(botId: string, threadId: string, why = "", now = Date.now()): void {
  poolLosses.set(poolChat(botId, threadId), { at: now, taken: false, memory: why.startsWith(MEMORY_CLOSE), avoid: false });
}

export function poolAvoided(botId: string, threadId: string, now = Date.now()): boolean {
  const loss = poolLosses.get(poolChat(botId, threadId));
  return loss !== undefined && loss.avoid && now - loss.at < POOL_AVOID_MS;
}

export function takePoolLoss(botId: string, threadId: string, now = Date.now()): boolean {
  const loss = poolLosses.get(poolChat(botId, threadId));
  if (!loss || loss.taken || now - loss.at > 2 * 60_000) return false;
  loss.taken = true;
  loss.avoid = !loss.memory;
  return true;
}

export function poolChosen(dataDir: string, botId: string): boolean {
  return poolChosenFrom(poolSetting(dataDir), botId);
}

export interface PoolSetting { enabled: boolean; bots?: string[]; skip?: string[] }

export function poolSetting(dataDir: string): PoolSetting {
  try {
    const pool = (JSON.parse(readFileSync(join(dataDir, REMOTE_ENGINES_FILE), "utf8")) as { pool?: { enabled?: unknown; bots?: unknown; skip?: unknown } }).pool;
    const ids = (list: unknown) => Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : undefined;
    const bots = ids(pool?.bots);
    const skip = ids(pool?.skip);
    return { enabled: pool?.enabled === true, ...(bots ? { bots } : {}), ...(skip?.length ? { skip } : {}) };
  } catch { return { enabled: false }; }
}

export function savePoolSetting(dataDir: string, setting: PoolSetting): PoolSetting {
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(join(dataDir, REMOTE_ENGINES_FILE), "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The saved engine placement could not be read, so it was left unchanged."); }
  const pool = { enabled: setting.enabled, ...(setting.bots ? { bots: [...new Set(setting.bots)] } : {}), ...(setting.skip?.length ? { skip: [...new Set(setting.skip)] } : {}) };
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileAtomic(join(dataDir, REMOTE_ENGINES_FILE), `${JSON.stringify({ ...saved, pool }, null, 2)}\n`, { mode: 0o600 });
  return pool;
}

export function poolChosenFrom(setting: PoolSetting, botId: string): boolean {
  return setting.enabled && (!setting.bots || setting.bots.includes(botId)) && !setting.skip?.includes(botId);
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
  close(chat: string): Promise<boolean>;
  stream(chat: string, signal?: AbortSignal): Promise<WebSocket>;
}

export class PoolNotWarm extends Error {}

export function poolService(): PoolService | null {
  const connection = computersConnection();
  if (!connection || (connection.source === "trial" && !savedTrial()?.included)) return null;
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
      try {
        const response = await fetch(`${base}/${chat}`, { method: "DELETE", headers, signal: AbortSignal.timeout(15_000) });
        await response.body?.cancel();
        return response.status === 200 || response.status === 404;
      } catch { return false; }
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

export const POOL_REATTACH_TRIES = 3;
export const POOL_REATTACH_PAUSE_MS = 1_000;

export function poolLink(first: WebSocket, stop: () => Promise<boolean>, timing: { pingMs: number; silentMs: number } = { pingMs: POOL_PING_MS, silentMs: POOL_SILENT_MS }, onLost?: (why: string) => void, reattach?: () => Promise<WebSocket>): EngineLink {
  const link = new EventEmitter() as EngineLink;
  let socket = first;
  let closed = false;
  let rejoining = false;
  const outbox: string[] = [];
  let partial: Buffer = Buffer.alloc(0);
  let heard = Date.now();
  let lastWords = "";
  const said = (text: string) => { lastWords = `${lastWords}${text}`.slice(-600); link.emit("diagnostic", text); };
  const waiting: string[] = [];
  const deliver = (line: string) => { if (link.listenerCount("line")) link.emit("line", line); else waiting.push(line); };
  link.on("newListener", (name) => { if (name === "line") queueMicrotask(() => { for (const line of waiting.splice(0)) link.emit("line", line); }); });
  const close = (why: string) => {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    const lastLine = lastWords.trim().split("\n").at(-1)?.trim();
    if (!CLEAN_CLOSES.includes(why)) onLost?.(lastLine ? `${why}: ${lastLine}` : why);
    try { socket.terminate(); } catch {}
    void stop().catch(() => false).then((stopped) => {
      if (stopped) deliver(POOL_EXIT_LINE);
      link.emit("close", why);
    });
  };
  const rejoin = (from: WebSocket, why: string) => {
    if (closed || from !== socket || rejoining) return;
    if (!reattach) { close(why); return; }
    rejoining = true;
    void (async () => {
      for (let attempt = 1; attempt <= POOL_REATTACH_TRIES && !closed; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POOL_REATTACH_PAUSE_MS * attempt));
        if (closed) return;
        try {
          const next = await reattach();
          if (closed) { next.terminate(); return; }
          socket = next;
          heard = Date.now();
          wire(next);
          rejoining = false;
          link.emit("diagnostic", `pool stream reattached after: ${why}\n`);
          for (const line of outbox.splice(0)) next.send(Buffer.from(`${line}\n`));
          return;
        } catch {}
      }
      rejoining = false;
      close(why);
    })();
  };
  const beat = setInterval(() => {
    if (rejoining) return;
    if (Date.now() - heard > timing.silentMs) {
      const quiet = socket;
      try { quiet.terminate(); } catch {}
      rejoin(quiet, "the pool stream went silent");
      return;
    }
    try { socket.ping(); } catch {}
  }, timing.pingMs);
  beat.unref?.();
  const hear = () => { heard = Date.now(); };
  const onMessage = (from: WebSocket) => (data: WebSocket.RawData, binary: boolean) => {
    if (from !== socket) return;
    hear();
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (!binary) {
      let frame: { channel?: string; code?: unknown; reason?: unknown; message?: unknown };
      try { frame = JSON.parse(bytes.toString("utf8")); } catch { return; }
      if (frame.channel === "exit") close(`pool relay exited ${String(frame.code)}`);
      else if (frame.channel === "closed") close(`pool closed the engine: ${String(frame.reason)}`);
      else if (frame.channel === "error") said(String(frame.message ?? "pool stream error"));
      return;
    }
    const body = bytes.subarray(1);
    if (bytes[0] === 2) { said(body.toString("utf8")); return; }
    partial = partial.length ? Buffer.concat([partial, body]) : body;
    let newline: number;
    while ((newline = partial.indexOf(10)) >= 0) {
      deliver(partial.subarray(0, newline).toString("utf8"));
      partial = partial.subarray(newline + 1);
    }
  };
  function wire(next: WebSocket): void {
    next.on("pong", hear);
    next.on("ping", hear);
    next.on("message", onMessage(next));
    next.on("close", () => rejoin(next, "pool stream closed"));
    next.on("error", () => rejoin(next, "pool stream failed"));
  }
  wire(first);
  link.send = (line) => {
    if (closed) return;
    if (rejoining || socket.readyState !== socket.OPEN) { outbox.push(line); return; }
    socket.send(Buffer.from(`${line}\n`));
  };
  link.close = () => close("closed by the home");
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
  launch.homeCwd = plan.stagingDir;
  launch.socketPath = rebase(launch.socketPath);
  launch.stateFile = rebase(launch.stateFile);
  launch.lockFile = rebase(launch.lockFile);
  delete launch.workFolders;
  const promptAt = launch.args.indexOf("--append-system-prompt-file") + 1;
  const promptFile = promptAt > 0 ? launch.args[promptAt] : undefined;
  if (promptFile && promptFile.startsWith(`${plan.stagingDir}/`)) appendFileSync(promptFile, POOL_NOTE);
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

export async function openOnPool(pool: PoolService, botId: string, plan: ClaudeRemotePlan, computerProxy: string, signal?: AbortSignal, layout: PoolLayout = POOL_LAYOUT, onLost?: (why: string) => void): Promise<{ link: EngineLink; state: string; slot: number }> {
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
      return { link: poolLink(socket, () => pool.close(chat), undefined, onLost, () => pool.stream(chat)), state: opened.state ?? "cold", slot: opened.slot };
    } catch (error) {
      if (attempt === 0 && error instanceof PoolNotWarm && !signal?.aborted) continue;
      await pool.close(chat);
      throw error;
    }
  }
}

export function poolEngineOpener(computer: EngineOpener, dataDir: string, service: () => PoolService | null = poolService, makeFolder: (path: string) => Promise<void> = async () => {}): EngineOpener {
  const onComputer = async (botId: string, plan: ClaudeRemotePlan, signal?: AbortSignal) => {
    await makeFolder(plan.launch.cwd).catch(() => {});
    return computer.open(botId, plan, signal);
  };
  return {
    get proxyPath() { return computer.proxyPath; },
    get guestProvider() { return computer.guestProvider; },
    get remoteBase() { return computer.remoteBase; },
    openBudgetMs: computer.openBudgetMs,
    async open(botId, plan, signal) {
      if (!poolChosen(dataDir, botId) || !poolFits(plan)) return computer.open(botId, plan, signal);
      const who = `${botId.slice(0, 8)} ${plan.threadId.slice(0, 8)}`;
      if (poolAvoided(botId, plan.threadId)) {
        notePlacement(dataDir, `[pool] ${who} uses the dog's computer: the pool lost this chat's engine in the last ${POOL_AVOID_MS / 60_000} minutes`);
        return onComputer(botId, plan, signal);
      }
      const began = Date.now();
      try {
        const pool = service();
        if (!pool) throw new Error("this home has no computers service for the pool");
        const opened = await openOnPool(pool, botId, plan, computer.proxyPath, signal, POOL_LAYOUT, (why) => {
          notePoolLoss(botId, plan.threadId, why);
          notePlacement(dataDir, `[pool] ${who} lost its pool engine (${why})`);
        });
        notePlacement(dataDir, `[pool] ${who} engine opened on pool slot ${opened.slot} in ${Date.now() - began} ms`);
        poolThreads.add(plan.threadId);
        opened.link.once("close", () => poolThreads.delete(plan.threadId));
        return opened.link;
      } catch (error) {
        if (signal?.aborted) throw error;
        notePlacement(dataDir, `[pool] ${who} falls back to the dog's computer after ${Date.now() - began} ms: ${error instanceof Error ? error.message : String(error)}`);
        return onComputer(botId, plan, signal);
      }
    },
  };
}
