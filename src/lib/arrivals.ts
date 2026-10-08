// Which transcript rows arrived after a chat was opened.
//
// A row that was already there when the chat opened sits still; one that
// arrives later rises in (`[data-arriving]` in styles.css). The set of rows
// present at the first render is remembered per chat, so switching chats
// never plays a wall of entrances, and a row stays "arrived" for as long as
// the chat is open — it is the chat's own first render that settles.
import { useRef } from "react";

export interface Arrivals {
  /** The chat these rows belong to; a new key settles a new set. */
  key: string;
  /** Ids present at the chat's first render. */
  settled: ReadonlySet<string>;
}

/** The settled set for `key`: the previous one while the key holds, else `ids` now. */
export function settle(previous: Arrivals | null, key: string, ids: Iterable<string>): Arrivals {
  if (previous && previous.key === key) return previous;
  return { key, settled: new Set(ids) };
}

/** Whether a row with this id arrived after the chat's first render. */
export function arrived(arrivals: Arrivals, id: string): boolean {
  return !arrivals.settled.has(id);
}

/** React hook: `arriving(id)` for the rows of the chat `key`. */
export function useArrivals(key: string, rows: readonly { id: string }[]): (id: string) => boolean {
  const ref = useRef<Arrivals | null>(null);
  ref.current = settle(ref.current, key, rows.map((row) => row.id));
  const current = ref.current;
  return (id) => arrived(current, id);
}
