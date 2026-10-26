import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic.ts";

export const SNAPSHOT_WAIT_MS = 1_500;
export const SNAPSHOT_KEPT_MS = 24 * 60 * 60_000;
export const SLOW_CHECK_MS = 500;
export const SLOW_RECHECK_MS = 30_000;
const SAVE_AFTER_MS = 1_000;
const INSTANCE_PATH = /^\/api\/instances\/([\w.-]+)\//;

export function instanceTouchedBy(path: string): string | null {
  return INSTANCE_PATH.exec(path)?.[1] ?? null;
}

interface Kept<S> {
  owner: object;
  snapshot: S;
  at: number;
  took: number;
}

interface Saved<S> {
  identity: string;
  snapshot: S;
  at: number;
  took: number;
}

function savedAnswers<S>(file: string | undefined): Map<string, Saved<S>> {
  if (!file) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, Saved<S>>;
    return new Map(Object.entries(parsed).filter(([, saved]) => typeof saved?.identity === "string" && typeof saved.at === "number"));
  } catch {
    return new Map();
  }
}

export function createSnapshotCache<S>(options: {
  now?: () => number;
  waitMs?: number;
  keptMs?: number;
  slowMs?: number;
  recheckSlowMs?: number;
  file?: string;
  identity?: (owner: object) => string;
  settled?: (snapshot: S) => boolean;
} = {}) {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? SNAPSHOT_WAIT_MS;
  const keptMs = options.keptMs ?? SNAPSHOT_KEPT_MS;
  const slowMs = options.slowMs ?? SLOW_CHECK_MS;
  const recheckSlowMs = options.recheckSlowMs ?? SLOW_RECHECK_MS;
  const settled = options.settled ?? (() => true);
  const kept = new Map<string, Kept<S>>();
  const saved = savedAnswers<S>(options.file);
  const running = new Map<string, { owner: object; check: Promise<S> }>();
  let saving: ReturnType<typeof setTimeout> | null = null;

  const save = () => {
    const file = options.file;
    const identity = options.identity;
    if (!file || !identity || saving) return;
    saving = setTimeout(() => {
      saving = null;
      for (const [id, entry] of kept) saved.set(id, { identity: identity(entry.owner), snapshot: entry.snapshot, at: entry.at, took: entry.took });
      try {
        writeFileAtomic(file, `${JSON.stringify(Object.fromEntries(saved))}\n`, { mode: 0o600 });
      } catch {
        return;
      }
    }, SAVE_AFTER_MS);
    saving.unref?.();
  };

  const check = (id: string, owner: object, take: () => Promise<S>): Promise<S> => {
    const current = running.get(id);
    if (current?.owner === owner) return current.check;
    const startedAt = now();
    const started = take().then((snapshot) => {
      if (!settled(snapshot)) return lastAnswer(id, owner)?.snapshot ?? snapshot;
      if (running.get(id)?.check === started) {
        kept.set(id, { owner, snapshot, at: now(), took: now() - startedAt });
        save();
      }
      return snapshot;
    }).finally(() => {
      if (running.get(id)?.check === started) running.delete(id);
    });
    running.set(id, { owner, check: started });
    return started;
  };

  const lastAnswer = (id: string, owner: object): { snapshot: S; took: number; at: number; fromBefore: boolean } | null => {
    const last = kept.get(id);
    if (last) return last.owner === owner && now() - last.at < keptMs ? { ...last, fromBefore: false } : null;
    const earlier = saved.get(id);
    if (!earlier || !options.identity || earlier.identity !== options.identity(owner) || now() - earlier.at >= keptMs) return null;
    return { ...earlier, fromBefore: true };
  };

  return {
    read(id: string, owner: object, take: () => Promise<S>): Promise<S> {
      const last = lastAnswer(id, owner);
      if (last && last.took >= slowMs) {
        if (last.fromBefore || now() - last.at >= recheckSlowMs) check(id, owner, take).catch(() => undefined);
        return Promise.resolve(last.snapshot);
      }
      const fresh = check(id, owner, take);
      if (!last) return fresh;
      fresh.catch(() => undefined);
      return new Promise<S>((resolve, reject) => {
        const timer = setTimeout(() => resolve(last.snapshot), waitMs);
        timer.unref?.();
        fresh.then((snapshot) => { clearTimeout(timer); resolve(snapshot); }, (error: unknown) => { clearTimeout(timer); reject(error); });
      });
    },
    forget(id: string): void {
      kept.delete(id);
      running.delete(id);
      if (saved.delete(id)) save();
    },
    clear(): void {
      kept.clear();
      running.clear();
      saved.clear();
      save();
    },
  };
}
