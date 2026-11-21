import { createHash } from "node:crypto";

import { callKey } from "../repeat-detector.ts";

export const SAME_ANSWER_LIMIT = 10;

export interface SameAnswerLoopFound {
  call: string;
  times: number;
}

interface CallRun {
  answer: string;
  times: number;
}

interface ThreadCalls {
  pending: Map<string, { key: string; call: string }>;
  runs: Map<string, CallRun>;
  ended: boolean;
}

function answerOf(ok: boolean, output: string | undefined): string | undefined {
  const text = output?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return createHash("sha256").update(`${ok ? "ok" : "failed"}\u0000${text}`).digest("hex");
}

export class SameAnswerLoop {
  private readonly threads = new Map<string, ThreadCalls>();
  private readonly limit: number;
  private readonly maxCallsPerThread: number;

  constructor(opts: { limit?: number; maxCallsPerThread?: number } = {}) {
    this.limit = opts.limit ?? SAME_ANSWER_LIMIT;
    this.maxCallsPerThread = opts.maxCallsPerThread ?? 256;
    if (!Number.isInteger(this.limit) || this.limit < 2) throw new Error("limit must be an integer of at least 2");
  }

  started(threadId: string, call: { itemId?: string; tool: string; args?: string; shown?: string }): void {
    if (!call.itemId) return;
    const key = callKey(call.tool, call.args);
    if (!key) return;
    const thread = this.thread(threadId);
    if (thread.pending.size >= this.maxCallsPerThread) thread.pending.delete(thread.pending.keys().next().value!);
    thread.pending.set(call.itemId, { key, call: (call.shown ?? "").replace(/\s+/g, " ").trim() || call.tool });
  }

  completed(threadId: string, result: { itemId?: string; ok: boolean; output?: string }): SameAnswerLoopFound | undefined {
    const thread = this.threads.get(threadId);
    const started = result.itemId ? thread?.pending.get(result.itemId) : undefined;
    if (!thread || !started) return undefined;
    thread.pending.delete(result.itemId!);
    const answer = answerOf(result.ok, result.output);
    const previous = thread.runs.get(started.key);
    thread.runs.delete(started.key);
    if (!answer) return undefined;
    if (!previous && thread.runs.size >= this.maxCallsPerThread) thread.runs.delete(thread.runs.keys().next().value!);
    const times = previous?.answer === answer ? previous.times + 1 : 1;
    thread.runs.set(started.key, { answer, times });
    if (times < this.limit || thread.ended) return undefined;
    thread.ended = true;
    return { call: started.call, times };
  }

  settle(threadId: string): void {
    this.threads.delete(threadId);
  }

  private thread(threadId: string): ThreadCalls {
    let thread = this.threads.get(threadId);
    if (!thread) this.threads.set(threadId, (thread = { pending: new Map(), runs: new Map(), ended: false }));
    return thread;
  }
}

export function sameAnswerLine(name: string | undefined, found: SameAnswerLoopFound): string {
  const call = found.call.length > 80 ? `${found.call.slice(0, 80)}…` : found.call;
  return `${name?.trim() || "The dog"} stopped: it ran ${call} ${found.times} times and got the same answer every time. It is waiting for that answer to change. Reply when it should try again or do something else.`;
}
