import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";

export const SKILLS_PROMPT_WAIT_MS = 3_000;
const STUCK_MS = 60_000;

type Reply = { id: number; text?: string; failed?: string };

export interface SkillsPromptSource {
  compose(botId: string, assigned: readonly string[] | undefined): Promise<string>;
  close(): Promise<void>;
}

export function skillsPromptWorker(): SkillsPromptSource {
  let worker: Worker | undefined;
  let sequence = 0;
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const drop = (reason: string) => {
    const stale = worker;
    worker = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
    void stale?.terminate();
  };
  const start = () => {
    const source = new URL("./skills-prompt.worker.ts", import.meta.url);
    const next = new Worker(existsSync(source) ? source : new URL("./skills-prompt.worker.js", import.meta.url), { execArgv: [] });
    next.on("message", (reply: Reply) => {
      const request = pending.get(reply.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(reply.id);
      if (reply.failed !== undefined) request.reject(new Error(reply.failed));
      else request.resolve(reply.text ?? "");
      if (!pending.size) next.unref();
    });
    next.on("error", () => { if (worker === next) drop("the skills reader stopped"); });
    next.on("exit", () => { if (worker === next) drop("the skills reader stopped"); });
    return next;
  };
  return {
    compose(botId, assigned) {
      worker ??= start();
      const current = worker;
      current.ref();
      const id = ++sequence;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { if (worker === current) drop("the skills reader was stuck on a folder"); }, STUCK_MS);
        pending.set(id, { resolve, reject, timer });
        current.postMessage({ id, botId, ...(assigned ? { assigned: [...assigned] } : {}) });
      });
    },
    async close() {
      drop("closed");
    },
  };
}

export class SkillsPromptCache {
  private readonly last = new Map<string, string>();
  private readonly running = new Map<string, Promise<string>>();
  private readonly source: SkillsPromptSource;
  private readonly waitMs: number;

  constructor(source: SkillsPromptSource, waitMs = SKILLS_PROMPT_WAIT_MS) {
    this.source = source;
    this.waitMs = waitMs;
  }

  async get(botId: string, assigned: readonly string[] | undefined): Promise<{ text: string; fresh: boolean }> {
    const key = `${botId}\n${JSON.stringify(assigned ?? null)}`;
    let work = this.running.get(key);
    if (!work) {
      work = this.source.compose(botId, assigned).then((text) => {
        this.last.set(key, text);
        return text;
      }).finally(() => this.running.delete(key));
      work.catch(() => {});
      this.running.set(key, work);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.waitMs); });
    try {
      const text = await Promise.race([work, late]);
      if (text !== null) return { text, fresh: true };
    } catch {
    } finally {
      clearTimeout(timer);
    }
    return { text: this.last.get(key) ?? "", fresh: false };
  }
}
