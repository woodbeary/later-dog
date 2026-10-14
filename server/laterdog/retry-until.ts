export interface RetryUntilOptions {
  everyMs: number;
  forMs: number;
  onGiveUp?: (error: unknown) => void;
}

export function retryUntilDone(attempt: () => void, options: RetryUntilOptions): void {
  const deadline = Date.now() + options.forMs;
  const next = () => {
    const timer = setTimeout(() => {
      try {
        attempt();
      } catch (error) {
        if (Date.now() >= deadline) {
          options.onGiveUp?.(error);
          return;
        }
        next();
      }
    }, options.everyMs);
    timer.unref?.();
  };
  next();
}
