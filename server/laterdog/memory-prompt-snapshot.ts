export const FRESH_MEMORY_WAIT_MS = 300;

export async function quickMemorySnapshot(
  fresh: Promise<ReadonlyMap<string, string> | null>,
  last: ReadonlyMap<string, string>,
  waitMs = FRESH_MEMORY_WAIT_MS,
): Promise<ReadonlyMap<string, string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); timer.unref?.(); });
  const first = await Promise.race([fresh.catch(() => null), late]).finally(() => clearTimeout(timer));
  if (first) return first;
  return last.size ? last : null;
}
