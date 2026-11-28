export const BOT_BROADCAST_MS = 250;
export const BROADCAST_SLICE_MS = 20;

export interface CoalescedBroadcasts {
  soon(id: string): void;
  flush(): void;
}

export function coalescedBroadcasts(
  delayMs: number,
  send: (id: string) => void,
  options: { sliceMs?: number; now?: () => number; yieldTo?: (next: () => void) => void } = {},
): CoalescedBroadcasts {
  const sliceMs = options.sliceMs ?? BROADCAST_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const yieldTo = options.yieldTo ?? ((next) => { setImmediate(next); });
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resuming = false;
  let generation = 0;
  const sendOne = (id: string) => {
    waiting.delete(id);
    try {
      send(id);
    } catch (error) {
      console.warn(`[broadcast] could not send ${id}: ${(error as Error).message}`);
    }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const id of [...waiting]) sendOne(id);
  };
  const slice = () => {
    timer = null;
    resuming = false;
    const until = now() + sliceMs;
    for (const id of waiting) {
      sendOne(id);
      if (waiting.size && now() >= until) {
        resuming = true;
        const mine = ++generation;
        yieldTo(() => { if (resuming && generation === mine) slice(); });
        return;
      }
    }
  };
  return {
    soon(id) {
      waiting.add(id);
      if (timer || resuming) return;
      timer = setTimeout(slice, delayMs);
      timer.unref?.();
    },
    flush() {
      resuming = false;
      flush();
    },
  };
}
