import { useRef } from "react";

export interface Arrivals {
  key: string;
  settled: ReadonlySet<string>;
}

export function settle(previous: Arrivals | null, key: string, ids: Iterable<string>): Arrivals {
  if (previous && previous.key === key) return previous;
  return { key, settled: new Set(ids) };
}

export function arrived(arrivals: Arrivals, id: string): boolean {
  return !arrivals.settled.has(id);
}

export function useArrivals(key: string, rows: readonly { id: string }[]): (id: string) => boolean {
  const ref = useRef<Arrivals | null>(null);
  ref.current = settle(ref.current, key, rows.map((row) => row.id));
  const current = ref.current;
  return (id) => arrived(current, id);
}
