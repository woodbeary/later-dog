import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { dogFoldersMounted, mountGuard } from "./laterdog/dog-mounts.ts";
import { MOUNTED_FOLDER_ANSWER_MS } from "./laterdog/mounted-folder-gate.ts";
import * as skills from "./skills.ts";
import { workspaceDir } from "./workspace.ts";

export const SKILL_OPS = [
  "syncSkillLinks", "listSkills", "readSkillFile", "installSkill", "installOrgSkill", "skillPackageStamps", "setSkillEnabled",
  "removeSkill", "stageSkillWrite", "listStagedSkillWrites", "getStagedSkillWrite", "rejectStagedSkillWrite", "applyStagedSkillWrite",
  "applySkillWriteWithReceipt", "undoSkillWrite", "skillsSystemPrompt", "resolveBotSkills", "listBotSkillsWithOrigin",
] as const;

export type SkillOp = typeof SKILL_OPS[number];
export const RECEIPT_FAILED = "The receipt for this skill change could not be recorded.";
type Skills = typeof skills;
type Args<K extends SkillOp> = Parameters<Skills[K]>;
type Result<K extends SkillOp> = ReturnType<Skills[K]>;

export interface SkillCall {
  id: number;
  op: string;
  args: unknown[];
  receipt?: SharedArrayBuffer;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onApplied?: (skill: unknown) => void;
  receipt?: Int32Array;
  hookError?: unknown;
}

const POOL = 4;
const idle: Worker[] = [];
const busy = new Map<Worker, Pending>();
let sequence = 0;

function spawn(): Worker {
  const source = new URL("./skills.worker.ts", import.meta.url);
  const worker = new Worker(existsSync(source) ? source : new URL("./skills.worker.js", import.meta.url), { execArgv: [] });
  worker.on("message", (reply: { id: number; applied?: unknown; result?: unknown; error?: string }) => {
    const pending = busy.get(worker);
    if (!pending) return;
    if ("applied" in reply) {
      let answer = 1;
      try { pending.onApplied?.(reply.applied); } catch (error) { answer = 2; pending.hookError = error; }
      Atomics.store(pending.receipt!, 0, answer);
      Atomics.notify(pending.receipt!, 0);
      return;
    }
    busy.delete(worker);
    if (idle.length < POOL) { worker.unref(); idle.push(worker); } else void worker.terminate();
    if (reply.error !== undefined) pending.reject(pending.hookError instanceof Error && reply.error === RECEIPT_FAILED ? pending.hookError : new Error(reply.error));
    else pending.resolve(reply.result);
  });
  const lost = () => {
    const pending = busy.get(worker);
    busy.delete(worker);
    const at = idle.indexOf(worker);
    if (at >= 0) idle.splice(at, 1);
    pending?.reject(Object.assign(new Error("The skills helper stopped."), { code: "EIO" }));
  };
  worker.on("error", lost);
  worker.on("exit", lost);
  return worker;
}

function onThread<K extends SkillOp>(op: K, args: unknown[], onApplied?: (skill: unknown) => void): { worker: Worker; work: Promise<Result<K>> } {
  const worker = idle.pop() ?? spawn();
  worker.ref();
  const work = new Promise<Result<K>>((resolve, reject) => {
    const receipt = onApplied ? new SharedArrayBuffer(4) : undefined;
    busy.set(worker, { resolve: resolve as (value: unknown) => void, reject, onApplied, receipt: receipt && new Int32Array(receipt) });
    worker.postMessage({ id: ++sequence, op, args, receipt } satisfies SkillCall);
  });
  return { worker, work };
}

function withoutHook(op: SkillOp, args: unknown[]): { plain: unknown[]; onApplied?: (skill: unknown) => void } {
  if (op === "applySkillWriteWithReceipt" && typeof args[2] === "function") return { plain: args.slice(0, 2), onApplied: args[2] as (skill: unknown) => void };
  const options = args[2] as { onApplied?: (skill: unknown) => void } | undefined;
  if (op === "applyStagedSkillWrite" && typeof options?.onApplied === "function") {
    const { onApplied, ...rest } = options;
    return { plain: [args[0], args[1], rest], onApplied };
  }
  return { plain: args };
}

export async function skillsCall<K extends SkillOp>(botId: string, op: K, ...args: Args<K>): Promise<Result<K>> {
  if (!dogFoldersMounted()) return (skills[op] as unknown as (...inner: Args<K>) => Result<K>)(...args);
  const { plain, onApplied } = withoutHook(op, args);
  let started: { worker: Worker; work: Promise<Result<K>> } | undefined;
  try {
    return await mountGuard.run(workspaceDir(botId), () => {
      started = onThread(op, plain, onApplied);
      return started.work;
    });
  } catch (error) {
    if (started && busy.has(started.worker)) {
      busy.delete(started.worker);
      void started.work.catch(() => {});
      void started.worker.terminate();
    }
    throw error;
  }
}

export function skillWorkers(): number {
  return idle.length + busy.size;
}

const lastPrompts = new Map<string, string>();

export async function skillsPromptReady(botId: string, assignedLibrary?: readonly string[], budgetMs = MOUNTED_FOLDER_ANSWER_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); timer.unref?.(); });
  const fresh = skillsCall(botId, "skillsSystemPrompt", botId, assignedLibrary).then((text) => { lastPrompts.set(botId, text); return text; }, () => null);
  const text = await Promise.race([fresh, late]);
  clearTimeout(timer);
  return text ?? lastPrompts.get(botId) ?? "";
}
