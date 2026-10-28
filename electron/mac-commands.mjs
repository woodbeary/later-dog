import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

export const COMMAND_WAIT_DEFAULT_S = 25;
export const COMMAND_WAIT_MAX_S = 30;
export const COMMAND_OUTPUT_MAX = 256 * 1024;
export const COMMAND_INPUT_MAX = 64 * 1024;
const KEEP_BYTES = 1024 * 1024;
const MAX_RUNNING = 12;
const FORGET_AFTER_MS = 60 * 60_000;
const STOP_GRACE_MS = 3000;
const ENV_TIMEOUT_MS = 6000;
const ENV_MARK = "__LATERDOG_LOGIN_ENV__";
const SHELL_ONLY = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PS1", "PS2", "PROMPT", "RPROMPT", "ZSH_EXECUTION_STRING", "TERM_SESSION_ID", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);
const FALLBACK_PATHS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const seconds = (since, now) => Math.round((now() - since) / 100) / 10;

export function parseLoginEnvironment(stdout) {
  const text = typeof stdout === "string" ? stdout : String(stdout ?? "");
  const at = text.indexOf(`${ENV_MARK}\0`);
  if (at === -1) return null;
  const env = {};
  for (const entry of text.slice(at + ENV_MARK.length + 1).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const key = entry.slice(0, equals);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SHELL_ONLY.has(key)) continue;
    env[key] = entry.slice(equals + 1);
  }
  return env.PATH ? env : null;
}

export function baseEnvironment(source = process.env, home = os.homedir()) {
  const env = { HOME: home, PATH: FALLBACK_PATHS.join(":"), LANG: source.LANG || "en_US.UTF-8" };
  for (const key of ["USER", "LOGNAME", "SHELL", "TMPDIR"]) if (source[key]) env[key] = source[key];
  return env;
}

export function createLoginEnvironment({ source = process.env, home = os.homedir(), spawnImpl = spawn, timeoutMs = ENV_TIMEOUT_MS } = {}) {
  let pending = null;
  const resolve = () => new Promise(done => {
    const base = baseEnvironment(source, home);
    const shell = /^\/[\w./-]+$/.test(source.SHELL ?? "") ? source.SHELL : "/bin/zsh";
    let child;
    try {
      child = spawnImpl(shell, ["-ilc", `printf '%s\\0' ${ENV_MARK}; /usr/bin/env -0`], { cwd: home, env: { ...base, TERM: "dumb" }, stdio: ["ignore", "pipe", "ignore"], detached: true });
    } catch { return done(base); }
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill?.("SIGKILL"); } }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes <= 1024 * 1024) chunks.push(chunk); });
    child.once("error", () => { clearTimeout(timer); done(base); });
    child.once("close", () => {
      clearTimeout(timer);
      const parsed = parseLoginEnvironment(Buffer.concat(chunks).toString("utf8"));
      done(parsed ? { ...parsed, HOME: home } : base);
    });
  });
  return () => (pending ??= resolve());
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

function unreadOutput(entry, limit) {
  const all = Buffer.concat(entry.chunks);
  entry.chunks = [];
  entry.held = 0;
  const skipped = Math.max(0, all.length - limit);
  return { text: all.subarray(skipped).toString("utf8"), skipped: skipped + entry.dropped };
}

export function createCommandRunner({ environment, spawnImpl = spawn, now = Date.now, keepBytes = KEEP_BYTES, maxRunning = MAX_RUNNING } = {}) {
  const commands = new Map();
  const forget = () => {
    for (const [id, entry] of commands) if (entry.done && now() - entry.endedAt > FORGET_AFTER_MS) commands.delete(id);
  };
  const report = (id, entry, limit = COMMAND_OUTPUT_MAX) => {
    const { text, skipped } = unreadOutput(entry, limit);
    entry.dropped = 0;
    return {
      command_id: id,
      running: !entry.done,
      ...(entry.done ? { exitCode: entry.exitCode, ...(entry.signal ? { signal: entry.signal } : {}) } : {}),
      output: text,
      ...(skipped ? { skipped_bytes: skipped } : {}),
      seconds: seconds(entry.startedAt, entry.done ? () => entry.endedAt : now),
    };
  };
  const settle = (entry, waitMs, signal) => new Promise(resolve => {
    if (entry.done || waitMs <= 0) return resolve();
    const finish = () => { clearTimeout(timer); entry.waiters.delete(finish); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, waitMs);
    entry.waiters.add(finish);
    signal?.addEventListener("abort", finish, { once: true });
  });
  const lookup = id => {
    const entry = typeof id === "string" ? commands.get(id) : undefined;
    if (!entry) throw new Error("No such command on this Mac. It may have finished over an hour ago or later.dog restarted; run it again if needed.");
    return entry;
  };
  const waitMs = value => Math.max(0, Math.min(COMMAND_WAIT_MAX_S, Number.isFinite(value) ? value : COMMAND_WAIT_DEFAULT_S)) * 1000;
  return {
    async start({ command, cwd, waitSeconds, signal }) {
      if (typeof command !== "string" || !command.trim() || command.length > 8000) throw new Error("Give a command of at most 8000 characters");
      signal?.throwIfAborted();
      forget();
      if ([...commands.values()].filter(entry => !entry.done).length >= maxRunning) {
        throw new Error(`${maxRunning} commands are already running on this Mac. Check or stop one (command_output, command_stop) before starting another.`);
      }
      const env = { ...(await environment()), TERM: "dumb", GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GIT_PAGER: "cat" };
      signal?.throwIfAborted();
      const child = spawnImpl("/bin/bash", ["-c", command], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const id = randomUUID();
      const entry = { child, chunks: [], held: 0, dropped: 0, done: false, exitCode: null, signal: null, startedAt: now(), endedAt: 0, waiters: new Set() };
      commands.set(id, entry);
      const keep = chunk => {
        entry.chunks.push(chunk);
        entry.held += chunk.length;
        while (entry.held > keepBytes) {
          const first = entry.chunks[0];
          const excess = Math.min(first.length, entry.held - keepBytes);
          if (excess === first.length) entry.chunks.shift(); else entry.chunks[0] = first.subarray(excess);
          entry.held -= excess;
          entry.dropped += excess;
        }
      };
      child.stdout.on("data", keep);
      child.stderr.on("data", keep);
      child.stdin.on("error", () => {});
      const ended = (code, signalName) => {
        if (entry.done) return;
        entry.done = true;
        entry.exitCode = code;
        entry.signal = signalName ?? null;
        entry.endedAt = now();
        for (const wake of entry.waiters) wake();
      };
      child.once("error", error => { keep(Buffer.from(`\n${error.message}\n`)); ended(127, null); });
      child.once("close", (code, signalName) => ended(code, signalName));
      const stopForRequester = () => { if (!entry.done) signalGroup(child, "SIGKILL"); };
      signal?.addEventListener("abort", stopForRequester, { once: true });
      await settle(entry, waitMs(waitSeconds), signal);
      signal?.removeEventListener("abort", stopForRequester);
      if (signal?.aborted && !entry.done) {
        signalGroup(child, "SIGKILL");
        throw new Error("Computer access was revoked or the requesting turn ended, so the command was stopped. Inspect before retrying.");
      }
      return report(id, entry);
    },
    async output({ id, waitSeconds, signal }) {
      const entry = lookup(id);
      await settle(entry, waitMs(waitSeconds), signal);
      return report(id, entry);
    },
    input({ id, input, close }) {
      const entry = lookup(id);
      if (entry.done) throw new Error("That command already finished; its input is closed.");
      if (input !== undefined) {
        if (typeof input !== "string" || input.length > COMMAND_INPUT_MAX) throw new Error(`Send at most ${COMMAND_INPUT_MAX} characters of input at a time`);
        entry.child.stdin.write(input);
      }
      if (close) entry.child.stdin.end();
      return { command_id: id, running: true, sent: typeof input === "string" ? input.length : 0, ...(close ? { input_closed: true } : {}) };
    },
    async stop({ id }) {
      const entry = lookup(id);
      if (!entry.done) {
        signalGroup(entry.child, "SIGTERM");
        await settle(entry, STOP_GRACE_MS);
        if (!entry.done) {
          signalGroup(entry.child, "SIGKILL");
          await settle(entry, STOP_GRACE_MS);
        }
      }
      return report(id, entry);
    },
    warm: () => environment().then(() => {}, () => {}),
    running: () => [...commands.values()].filter(entry => !entry.done).length,
    stopAll() {
      for (const entry of commands.values()) if (!entry.done) signalGroup(entry.child, "SIGKILL");
    },
  };
}
