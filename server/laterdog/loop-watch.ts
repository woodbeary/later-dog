export const LOOP_HELD_MS = 250;

export function watchEventLoop(options: { log: (line: string) => void; everyMs?: number; heldMs?: number; now?: () => number; context?: () => string }): () => void {
  const everyMs = options.everyMs ?? 100;
  const heldMs = options.heldMs ?? LOOP_HELD_MS;
  const now = options.now ?? Date.now;
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const held = at - last - everyMs;
    last = at;
    if (held >= heldMs) options.log(`event loop held ${Math.round(held)} ms${options.context ? ` (${options.context()})` : ""}`);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
