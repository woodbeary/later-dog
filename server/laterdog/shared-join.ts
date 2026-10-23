export function createSharedJoins<T>() {
  const inFlight = new Map<string, Promise<T>>();
  return {
    pending(key: string): Promise<T> | undefined {
      return inFlight.get(key);
    },
    run(key: string, join: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing) return existing;
      const started = join().finally(() => {
        if (inFlight.get(key) === started) inFlight.delete(key);
      });
      inFlight.set(key, started);
      return started;
    },
  };
}
