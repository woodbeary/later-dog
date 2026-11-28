export type ShutdownStep = (() => void | Promise<void>) | { name: string; run: () => void | Promise<void> };

export interface GracefulShutdownOptions {
  cleanup: ReadonlyArray<ShutdownStep>;
  courtesy?: ReadonlyArray<ShutdownStep>;
  exit: (code: number) => void;
  timeoutMs?: number;
  courtesyMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

export const COURTESY_MS = 750;
export const SLOW_STEP_MS = 200;

function named(step: ShutdownStep, index: number, kind: string) {
  return typeof step === "function" ? { name: `${kind} step ${index + 1}`, run: step } : step;
}

function waitAtMost(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

export function createGracefulShutdown({
  cleanup,
  courtesy = [],
  exit,
  timeoutMs = 6_000,
  courtesyMs = COURTESY_MS,
  log = () => {},
  now = Date.now,
}: GracefulShutdownOptions): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    const began = now();
    const pending = new Set<string>();
    const track = (step: { name: string; run: () => void | Promise<void> }) => {
      pending.add(step.name);
      const at = now();
      return Promise.resolve().then(step.run).catch(() => undefined).finally(() => {
        pending.delete(step.name);
        const took = now() - at;
        if (took >= SLOW_STEP_MS) log(`shutdown: ${step.name} took ${took} ms`);
      });
    };
    const courteous = Promise.allSettled(courtesy.map((step, index) => track(named(step, index, "courtesy")))).then(() => undefined);
    const essential = Promise.allSettled(cleanup.map((step, index) => track(named(step, index, "cleanup")))).then(() => undefined);
    void waitAtMost(essential, timeoutMs)
      .then(() => waitAtMost(courteous, Math.max(0, courtesyMs - (now() - began))))
      .finally(() => {
        if (pending.size) log(`shutdown: left ${[...pending].join(", ")} unfinished after ${now() - began} ms`);
        exit(0);
      });
  };
}
