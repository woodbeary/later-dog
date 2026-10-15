import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { RESTART_EXIT_CODE, restartPolicy } from "../restart.ts";

export type CrashLimits = { perWindow: number; windowMs: number; firstDelayMs: number; maxDelayMs: number };
export const CRASH_LIMITS: CrashLimits = { perWindow: 5, windowMs: 10 * 60_000, firstDelayMs: 1_000, maxDelayMs: 30_000 };
export const STDERR_TAIL_LINES = 40;
export const STDERR_LINE_CHARS = 2_000;
export const STDERR_DRAIN_MS = 500;

export type ServerExit = { code: number | null; signal: NodeJS.Signals | null };
export type RestartReason = "stopping" | "asked" | "asked too often" | "crashed" | "crashed too often";
export type RestartDecision = { again: boolean; why: RestartReason; delayMs: number; crashes: number };
export type HomeServerRestarts = { decide(exit: ServerExit, stopping: boolean): RestartDecision };

export function crashDelay(crashes: number, limits: CrashLimits = CRASH_LIMITS): number {
  return Math.min(limits.maxDelayMs, limits.firstDelayMs * 2 ** Math.max(0, crashes - 1));
}

export function homeServerRestarts(now: () => number = Date.now, limits: CrashLimits = CRASH_LIMITS): HomeServerRestarts {
  const asked = restartPolicy(now);
  let crashes: number[] = [];
  return {
    decide(exit, stopping) {
      const at = now();
      crashes = crashes.filter((time) => at - time < limits.windowMs);
      if (stopping) return { again: false, why: "stopping", delayMs: 0, crashes: crashes.length };
      if (exit.code === RESTART_EXIT_CODE) {
        const again = asked.again(exit.code);
        return { again, why: again ? "asked" : "asked too often", delayMs: 0, crashes: crashes.length };
      }
      if (crashes.length >= limits.perWindow) return { again: false, why: "crashed too often", delayMs: 0, crashes: crashes.length };
      crashes.push(at);
      return { again: true, why: "crashed", delayMs: crashDelay(crashes.length, limits), crashes: crashes.length };
    },
  };
}

export function stderrTail(maxLines = STDERR_TAIL_LINES, maxChars = STDERR_LINE_CHARS) {
  const decoder = new StringDecoder("utf8");
  const kept: string[] = [];
  let partial = "";
  const keep = (raw: string) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) return;
    kept.push(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line);
    if (kept.length > maxLines) kept.splice(0, kept.length - maxLines);
  };
  return {
    push(chunk: Buffer | string) {
      const pieces = (partial + (typeof chunk === "string" ? chunk : decoder.write(chunk))).split("\n");
      partial = pieces.pop() ?? "";
      if (partial.length > maxChars) partial = partial.slice(0, maxChars + 1);
      for (const piece of pieces) keep(piece);
    },
    lines(): string[] {
      const last = partial.replace(/\r$/, "");
      if (!last.trim()) return [...kept];
      return [...kept, last.length > maxChars ? `${last.slice(0, maxChars)}…` : last].slice(-maxLines);
    },
  };
}

export function spokenDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export function serverExitReport(exit: ServerExit, ranMs: number, decision: RestartDecision, tail: readonly string[], limits: CrashLimits = CRASH_LIMITS): string {
  const how = `exit code ${exit.code ?? "none"}, signal ${exit.signal ?? "none"}, after ${spokenDuration(ranMs)}`;
  const span = spokenDuration(limits.windowMs);
  const headline = {
    stopping: `cloud home: the server stopped (${how})`,
    asked: `cloud home: the server asked to start again (${how}); starting it now`,
    "asked too often": `cloud home: the server asked to start again too many times in a row (${how}); stopping the home`,
    crashed: `cloud home: the server stopped unexpectedly (${how}); starting it again in ${spokenDuration(decision.delayMs)} (restart ${decision.crashes} of ${limits.perWindow} allowed in ${span})`,
    "crashed too often": `cloud home: the server stopped unexpectedly (${how}) after ${decision.crashes} restarts in ${span}; stopping the home so it starts fresh`,
  }[decision.why];
  if (decision.why === "stopping" || decision.why === "asked") return headline;
  if (!tail.length) return `${headline}\ncloud home: the server wrote nothing to stderr before it stopped`;
  return [`${headline}\ncloud home: the server's last ${tail.length} stderr lines:`, ...tail.map((line) => `  | ${line}`)].join("\n");
}

export type HomeServerSupervision = { child(): ChildProcess | null; stop(): void };
export type HomeServerSupervisionOptions = {
  failed: () => void;
  log?: (text: string) => void;
  echo?: (chunk: Buffer) => void;
  now?: () => number;
  restarts?: HomeServerRestarts;
  limits?: CrashLimits;
  later?: (run: () => void, ms: number) => () => void;
  drainMs?: number;
};

function laterTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
}

function settledWithin(done: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void done.then(() => { clearTimeout(timer); resolve(); });
  });
}

export function superviseHomeServer(start: () => ChildProcess, options: HomeServerSupervisionOptions): HomeServerSupervision {
  const now = options.now ?? Date.now;
  const limits = options.limits ?? CRASH_LIMITS;
  const log = options.log ?? ((text: string) => { process.stderr.write(`${text}\n`); });
  const echo = options.echo ?? ((chunk: Buffer) => { process.stderr.write(chunk); });
  const restarts = options.restarts ?? homeServerRestarts(now, limits);
  const later = options.later ?? laterTimer;
  const drainMs = options.drainMs ?? STDERR_DRAIN_MS;
  let current: ChildProcess | null = null;
  let stopping = false;
  let cancelPending: (() => void) | null = null;
  const run = () => {
    cancelPending = null;
    if (stopping) return;
    let child: ChildProcess;
    try {
      child = start();
    } catch (error) {
      log(`cloud home: the server could not be started: ${error instanceof Error ? error.message : String(error)}`);
      queueMicrotask(options.failed);
      return;
    }
    const startedAt = now();
    const tail = stderrTail();
    current = child;
    const stream = child.stderr;
    stream?.on("data", (chunk: Buffer) => { echo(chunk); tail.push(chunk); });
    stream?.on("error", () => {});
    const ended = stream ? new Promise<void>((resolve) => { stream.once("end", resolve); stream.once("close", resolve); }) : Promise.resolve();
    let settled = false;
    const settle = (exit: ServerExit) => {
      if (settled) return;
      settled = true;
      if (current === child) current = null;
      const ranMs = now() - startedAt;
      const decision = restarts.decide(exit, stopping);
      void settledWithin(ended, drainMs).then(() => {
        log(serverExitReport(exit, ranMs, decision, tail.lines(), limits));
        if (!decision.again) {
          if (decision.why !== "stopping") options.failed();
          return;
        }
        if (stopping) return;
        cancelPending = later(run, decision.delayMs);
      });
    };
    child.once("exit", (code, signal) => settle({ code, signal }));
    child.on("error", (error) => {
      log(`cloud home: the server process failed: ${error.message}`);
      if (child.pid === undefined) settle({ code: null, signal: null });
    });
  };
  run();
  return {
    child: () => current,
    stop() {
      stopping = true;
      cancelPending?.();
      cancelPending = null;
    },
  };
}
