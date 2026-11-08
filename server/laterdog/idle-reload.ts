export interface IdleReloadHost {
  busy: () => boolean;
  reload: () => Promise<void>;
  forceAfterMs: number;
  pollMs: number;
  now?: () => number;
  every?: (run: () => void, ms: number) => { stop: () => void };
  log?: (line: string) => void;
}

export function createIdleReload(host: IdleReloadHost) {
  const now = host.now ?? Date.now;
  const every = host.every ?? ((run: () => void, ms: number) => {
    const timer = setInterval(run, ms);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  });
  let waitingSince: number | null = null;
  let poll: { stop: () => void } | null = null;
  let running: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    if (running) await running.catch(() => {});
    waitingSince = null;
    poll?.stop();
    poll = null;
    running = host.reload();
    try { await running; } finally { running = null; }
  };

  const check = (): Promise<void> | null => {
    if (waitingSince === null || running) return null;
    const forced = now() - waitingSince >= host.forceAfterMs;
    if (host.busy() && !forced) return null;
    if (forced) host.log?.("turns kept running past the wait, so the new settings apply now");
    return run().catch((error) => host.log?.(`could not apply the new settings: ${error instanceof Error ? error.message : String(error)}`));
  };

  return {
    async request(): Promise<void> {
      if (!host.busy()) return run();
      if (waitingSince === null) {
        waitingSince = now();
        host.log?.("waiting for running turns to finish before applying the new settings");
        poll = every(() => { void check(); }, host.pollMs);
      }
    },
    check,
    waiting: () => waitingSince !== null,
  };
}
