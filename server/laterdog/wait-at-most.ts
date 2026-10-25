export const ENGINE_MODELS_WAIT_MS = 300;

export function waitAtMost(work: Promise<unknown>, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

export const CLOUD_QUIET_START_MS = 30_000;

export function readEngineModels(
  read: () => Promise<unknown>,
  options: { quietMs?: number; upMs?: () => number } = {},
): Promise<void> {
  const quietMs = options.quietMs ?? (process.env.LATERDOG_CLOUD_ROLE === "home" ? CLOUD_QUIET_START_MS : 0);
  const up = (options.upMs ?? (() => process.uptime() * 1000))();
  if (up >= quietMs) return waitAtMost(read(), ENGINE_MODELS_WAIT_MS);
  const later = setTimeout(() => {
    read().catch(() => undefined);
  }, quietMs - up);
  later.unref?.();
  return Promise.resolve();
}
