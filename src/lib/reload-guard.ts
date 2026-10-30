const RELOAD_EVENTS = ["vite:beforeUpdate", "vite:beforeFullReload", "vite:ws:disconnect"] as const;
const LONGEST_HOLD_MS = 5 * 60_000;

let holds = 0;
let waiting: Array<() => void> = [];

function letReloadsThrough(): void {
  if (holds > 0) return;
  const ready = waiting;
  waiting = [];
  for (const resume of ready) resume();
}

export function holdReloads(): () => void {
  holds += 1;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    holds -= 1;
    if (holds === 0) setTimeout(letReloadsThrough, 0);
  };
}

export function holdReloadsUntil<T>(work: Promise<T>): Promise<T> {
  return work.finally(holdReloads());
}

export function reloadsHeld(): boolean {
  return holds > 0;
}

export function untilReloadsFree(longestMs = LONGEST_HOLD_MS): Promise<void> {
  if (holds === 0) return Promise.resolve();
  console.info("[later.dog] holding the page update until dictation finishes");
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, longestMs);
    waiting.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

type HotEvents = { on(event: (typeof RELOAD_EVENTS)[number], listener: () => Promise<void>): void };

export function holdPageUpdatesWhileHeld(hot: HotEvents | undefined): void {
  for (const event of RELOAD_EVENTS) hot?.on(event, () => untilReloadsFree());
}

holdPageUpdatesWhileHeld(import.meta.hot);
