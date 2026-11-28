export const SCAN_SLICE_MS = 10;

export async function scanYielding<T>(items: readonly T[], visit: (item: T) => void, options: { sliceMs?: number; now?: () => number; pass?: () => Promise<void> } = {}): Promise<void> {
  const sliceMs = options.sliceMs ?? SCAN_SLICE_MS;
  const now = options.now ?? (() => performance.now());
  const pass = options.pass ?? (() => new Promise<void>((resolve) => { setImmediate(resolve); }));
  let until = now() + sliceMs;
  for (const item of items) {
    visit(item);
    if (now() < until) continue;
    await pass();
    until = now() + sliceMs;
  }
}
