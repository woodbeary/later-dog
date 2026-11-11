import { useRef } from "react";

export interface Arrivals {
  key: string;
  shown: ReadonlySet<string>;
  arrived: ReadonlySet<string>;
}

export function settle(previous: Arrivals | null, key: string, ids: readonly string[]): Arrivals {
  if (!previous || previous.key !== key) return { key, shown: new Set(ids), arrived: new Set() };
  if (ids.every((id) => previous.shown.has(id))) return previous;
  let newestShown = ids.length - 1;
  while (newestShown >= 0 && !previous.shown.has(ids[newestShown]!)) newestShown -= 1;
  const shown = new Set(previous.shown);
  const arrived = new Set(previous.arrived);
  ids.forEach((id, index) => {
    if (shown.has(id)) return;
    shown.add(id);
    if (index > newestShown) arrived.add(id);
  });
  return { key, shown, arrived };
}

export function arrived(arrivals: Arrivals, id: string): boolean {
  return arrivals.arrived.has(id);
}

export function useArrivals(key: string, rows: readonly { id: string }[]): (id: string) => boolean {
  const ref = useRef<Arrivals | null>(null);
  ref.current = settle(ref.current, key, rows.map((row) => row.id));
  const current = ref.current;
  return (id) => arrived(current, id);
}
