import type { SharedComputerOperation } from "../shared-computers.ts";

export const RUN_COMMAND_WAIT_SECONDS = 10;
export const MAC_WAIT_CUT_SHORT = "The person just sent you a message, which comes next. Answer it now. This command may still be running on their Mac: check it again with command_output once you have answered.";
const HELD_OUTPUT_MAX = 200_000;

type Send = (operation: SharedComputerOperation) => Promise<unknown>;

interface MacReport {
  command_id?: string;
  output?: string;
  skipped_bytes?: number;
  running?: boolean;
  [field: string]: unknown;
}

interface Taker {
  take(result: unknown): void;
  fail(error: unknown): void;
}

interface WatchedCommand {
  output: string;
  skipped: number;
  job: Promise<unknown> | null;
  taker: Taker | null;
}

export function readMacReport(result: unknown): MacReport | null {
  const text = (result as { content?: { text?: unknown }[] } | null)?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as MacReport : null;
  } catch {
    return null;
  }
}

export function macResult(report: MacReport): unknown {
  return { content: [{ type: "text", text: JSON.stringify(report) }] };
}

export function createMacWaits() {
  const wakers = new Map<string, Set<() => void>>();
  const watched = new Map<string, WatchedCommand>();

  const watchedFor = (commandId: string): WatchedCommand => {
    let entry = watched.get(commandId);
    if (!entry) {
      entry = { output: "", skipped: 0, job: null, taker: null };
      watched.set(commandId, entry);
    }
    return entry;
  };

  const hold = (entry: WatchedCommand, report: MacReport) => {
    const output = entry.output + (typeof report.output === "string" ? report.output : "");
    const over = Math.max(0, output.length - HELD_OUTPUT_MAX);
    entry.output = output.slice(over);
    entry.skipped += over + (typeof report.skipped_bytes === "number" ? report.skipped_bytes : 0);
  };

  const takeHeld = (entry: WatchedCommand): Pick<MacReport, "output" | "skipped_bytes"> => {
    const held = { ...(entry.output ? { output: entry.output } : {}), ...(entry.skipped ? { skipped_bytes: entry.skipped } : {}) };
    entry.output = "";
    entry.skipped = 0;
    return held;
  };

  const release = (commandId: string, entry: WatchedCommand, report: MacReport): MacReport => {
    hold(entry, report);
    const { output: _output, skipped_bytes: _skipped, ...rest } = report;
    const merged: MacReport = { ...rest, output: "", ...takeHeld(entry) };
    if (report.running === false && !entry.job) watched.delete(commandId);
    return merged;
  };

  const listen = (threadId: string | undefined, wake: () => void): (() => void) => {
    if (!threadId) return () => {};
    const waiting = wakers.get(threadId) ?? new Set<() => void>();
    waiting.add(wake);
    wakers.set(threadId, waiting);
    return () => {
      waiting.delete(wake);
      if (waiting.size === 0 && wakers.get(threadId) === waiting) wakers.delete(threadId);
    };
  };

  const startJob = (entry: WatchedCommand, operation: SharedComputerOperation, send: Send) => {
    const job = send(operation);
    entry.job = job;
    const settle = () => {
      if (entry.job === job) entry.job = null;
      const taker = entry.taker;
      entry.taker = null;
      return taker;
    };
    job.then(
      (result) => {
        const taker = settle();
        if (taker) return taker.take(result);
        const report = readMacReport(result);
        if (report) hold(entry, report);
      },
      (error: unknown) => settle()?.fail(error),
    );
  };

  const watchOutput = async (threadId: string | undefined, commandId: string, operation: SharedComputerOperation, send: Send): Promise<unknown> => {
    const entry = watchedFor(commandId);
    if (entry.taker) return await send(operation);
    if (!entry.job) startJob(entry, operation, send);
    const first = await new Promise<{ result: unknown } | "message">((resolve, reject) => {
      const taker: Taker = {
        take: (result) => { stop(); resolve({ result }); },
        fail: (error) => { stop(); reject(error); },
      };
      const stop = listen(threadId, () => {
        if (entry.taker !== taker) return;
        entry.taker = null;
        stop();
        resolve("message");
      });
      entry.taker = taker;
    });
    if (first === "message") return macResult({ command_id: commandId, waiting_cut_short: true, note: MAC_WAIT_CUT_SHORT, ...takeHeld(entry) });
    const report = readMacReport(first.result);
    return report ? macResult(release(commandId, entry, report)) : first.result;
  };

  return {
    async run(threadId: string | undefined, operation: SharedComputerOperation, send: Send): Promise<unknown> {
      if (operation.action === "run_command") {
        return await send({ ...operation, wait_seconds: Math.min(operation.wait_seconds ?? RUN_COMMAND_WAIT_SECONDS, RUN_COMMAND_WAIT_SECONDS) });
      }
      if (operation.action === "command_output" && operation.command_id) {
        return await watchOutput(threadId, operation.command_id, operation, send);
      }
      return await send(operation);
    },
    messageSent(threadId: string): void {
      const waiting = wakers.get(threadId);
      if (!waiting) return;
      for (const wake of waiting) wake();
    },
  };
}
