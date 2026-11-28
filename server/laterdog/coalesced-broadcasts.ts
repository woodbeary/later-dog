export const BOT_BROADCAST_MS = 100;

export interface CoalescedBroadcasts {
  soon(id: string): void;
  flush(): void;
}

export function coalescedBroadcasts(delayMs: number, send: (id: string) => void): CoalescedBroadcasts {
  const waiting = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const ids = [...waiting];
    waiting.clear();
    for (const id of ids) {
      try {
        send(id);
      } catch (error) {
        console.warn(`[broadcast] could not send ${id}: ${(error as Error).message}`);
      }
    }
  };
  return {
    soon(id) {
      waiting.add(id);
      if (timer) return;
      timer = setTimeout(flush, delayMs);
      timer.unref?.();
    },
    flush,
  };
}
