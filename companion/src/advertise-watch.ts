
export interface AddressWatchOptions {
  addresses: () => string[];
  advertise: () => Promise<boolean>;
  withdraw: () => Promise<void>;
  log?: (line: string) => void;
}

export interface AddressWatcher {
  check: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function createAddressWatcher(options: AddressWatchOptions): AddressWatcher {
  let known: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight = false;

  const check = async (): Promise<void> => {
    if (inflight) return;
    const current = [...options.addresses()].sort();
    const key = current.join(",");
    if (key === known) return;
    inflight = true;
    try {
      if (current.length === 0) {
        options.log?.("no LAN addresses — advertising paused until a network appears");
        await options.withdraw();
      } else {
        const ok = await options.advertise();
        options.log?.(
          ok
            ? `advertising on ${current.join(", ")}`
            : "could not advertise — pairing by typed address still works",
        );
      }
      known = key;
    } catch (error) {
      options.log?.(`advertise failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inflight = false;
    }
  };

  return {
    check,
    start: (intervalMs = DEFAULT_INTERVAL_MS) => {
      if (timer) return;
      timer = setInterval(() => void check(), intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
