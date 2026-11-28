export type LoopTurn = () => Promise<void>;

export function loopTurns(next: (run: () => void) => void = (run) => { setImmediate(run); }): LoopTurn {
  const waiting: Array<() => void> = [];
  let scheduled = false;
  const pump = () => {
    scheduled = false;
    waiting.shift()?.();
    if (waiting.length && !scheduled) {
      scheduled = true;
      next(pump);
    }
  };
  return () => new Promise<void>((resolve) => {
    waiting.push(resolve);
    if (scheduled) return;
    scheduled = true;
    next(pump);
  });
}
