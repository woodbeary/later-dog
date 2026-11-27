export const ASLEEP_REUSE_MS = 3_000;

type Checked<T> = { at: number; view: T | null };

export function coldViews<S extends { path: string }, T>(
  asleep: (scope: S) => Promise<boolean>,
  make: (scope: S) => Promise<T>,
  { reuseMs = ASLEEP_REUSE_MS, now = Date.now }: { reuseMs?: number; now?: () => number } = {},
): (scope: S) => Promise<T | null> {
  const views = new Map<string, T>();
  const checked = new Map<string, Checked<T>>();
  const pending = new Map<string, Promise<T | null>>();
  return (scope) => {
    const last = checked.get(scope.path);
    if (last && now() - last.at < reuseMs) return Promise.resolve(last.view);
    const running = pending.get(scope.path);
    if (running) return running;
    const work = (async () => {
      if (!(await asleep(scope))) {
        views.delete(scope.path);
        checked.set(scope.path, { at: now(), view: null });
        return null;
      }
      const view = views.get(scope.path) ?? await make(scope);
      views.set(scope.path, view);
      checked.set(scope.path, { at: now(), view });
      return view;
    })().finally(() => pending.delete(scope.path));
    pending.set(scope.path, work);
    return work;
  };
}
