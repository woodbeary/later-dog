export const SNAPSHOT_WAIT_MS = 1_500;
export const SNAPSHOT_KEPT_MS = 10 * 60_000;

interface Kept<S> {
  owner: object;
  snapshot: S;
  at: number;
}

export function createSnapshotCache<S>(options: { now?: () => number; waitMs?: number; keptMs?: number } = {}) {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? SNAPSHOT_WAIT_MS;
  const keptMs = options.keptMs ?? SNAPSHOT_KEPT_MS;
  const kept = new Map<string, Kept<S>>();
  const running = new Map<string, { owner: object; check: Promise<S> }>();

  const check = (id: string, owner: object, take: () => Promise<S>): Promise<S> => {
    const current = running.get(id);
    if (current?.owner === owner) return current.check;
    const started = take().then((snapshot) => {
      if (running.get(id)?.check === started) kept.set(id, { owner, snapshot, at: now() });
      return snapshot;
    }).finally(() => {
      if (running.get(id)?.check === started) running.delete(id);
    });
    running.set(id, { owner, check: started });
    return started;
  };

  return {
    read(id: string, owner: object, take: () => Promise<S>): Promise<S> {
      const fresh = check(id, owner, take);
      const last = kept.get(id);
      if (!last || last.owner !== owner || now() - last.at >= keptMs) return fresh;
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
    },
    clear(): void {
      kept.clear();
      running.clear();
    },
  };
}
