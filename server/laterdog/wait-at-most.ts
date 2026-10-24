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
