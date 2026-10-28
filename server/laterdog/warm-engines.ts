import { writeFile } from "node:fs/promises";
import { sessionIdlePolicy } from "../drivers/session-idle.ts";

export interface MemoryGauge {
  availableBytes(): number;
}

export type EnginePriority = (pid: number, resting: boolean) => void;

export interface RestingEngine {
  pid: number | undefined;
  idleMs: number | null;
  close: (why: string) => void;
}

export interface WarmEngines {
  rest(engine: object, resting: RestingEngine): void;
  wake(engine: object): void;
  forget(engine: object): void;
  makeRoom(bytes?: number): void;
}

export const ENGINE_BYTES = 256 * 1024 ** 2;
export const RESERVE_BYTES = 1024 ** 3;
const CHECK_EVERY_MS = 5_000;

export const linuxMemory: MemoryGauge | null = process.platform === "linux"
  ? { availableBytes: () => process.availableMemory() }
  : null;

export const closeRestingFirstOnLinux: EnginePriority = (pid, resting) => {
  if (process.platform !== "linux") return;
  void writeFile(`/proc/${pid}/oom_score_adj`, resting ? "1000" : "0").catch(() => {});
};

export function engineIdleLimit(
  driverPrefix: string,
  env: Record<string, string | undefined> = process.env,
  memory: MemoryGauge | null = linuxMemory,
): number | null {
  const configured = env[`LATERDOG_${driverPrefix}_SESSION_IDLE_MS`] ?? env.LATERDOG_SESSION_IDLE_MS;
  return configured === undefined && memory ? null : sessionIdlePolicy(driverPrefix, env).idleMs;
}

export function createWarmEngines({
  memory,
  priority = () => {},
  now = Date.now,
  checkEveryMs = CHECK_EVERY_MS,
}: {
  memory: MemoryGauge | null;
  priority?: EnginePriority;
  now?: () => number;
  checkEveryMs?: number;
}): WarmEngines {
  const resting = new Map<object, RestingEngine & { since: number; timer: ReturnType<typeof setTimeout> | null }>();
  let watch: ReturnType<typeof setInterval> | null = null;

  const take = (engine: object) => {
    const held = resting.get(engine);
    if (!held) return undefined;
    resting.delete(engine);
    if (held.timer) clearTimeout(held.timer);
    if (!resting.size && watch) {
      clearInterval(watch);
      watch = null;
    }
    return held;
  };

  const makeRoom = (bytes = 0) => {
    if (!memory || !resting.size) return;
    let short = RESERVE_BYTES + bytes - memory.availableBytes();
    const longestResting = [...resting.entries()].sort(([, a], [, b]) => a.since - b.since);
    for (const [engine] of longestResting) {
      if (short <= 0) return;
      take(engine)?.close("low memory");
      short -= ENGINE_BYTES;
    }
  };

  return {
    rest(engine, { pid, idleMs, close }) {
      take(engine);
      const timer = idleMs === null ? null : setTimeout(() => take(engine)?.close("idle"), idleMs);
      timer?.unref?.();
      resting.set(engine, { pid, idleMs, close, since: now(), timer });
      if (pid) priority(pid, true);
      if (memory && !watch) {
        watch = setInterval(() => makeRoom(), checkEveryMs);
        watch.unref?.();
      }
      makeRoom();
    },
    wake(engine) {
      const held = take(engine);
      if (held?.pid) priority(held.pid, false);
    },
    forget(engine) {
      take(engine);
    },
    makeRoom,
  };
}

export const warmEngines = createWarmEngines({ memory: linuxMemory, priority: closeRestingFirstOnLinux });
