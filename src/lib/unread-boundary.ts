import { useEffect, useRef, useState } from "react";

const KEY = "laterdog-seen-at";
const KEEP = 400;

type Store = Pick<Storage, "getItem" | "setItem"> | undefined;
export type SeenRow = { role: string; at: number };

function storage(): Store {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readAll(store: Store): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
    );
  } catch {
    return {};
  }
}

export function seenAt(thread: string, store: Store = storage()): number | null {
  return readAll(store)[thread] ?? null;
}

export function markSeen(thread: string, at: number, store: Store = storage()): void {
  if (!store || !Number.isFinite(at)) return;
  const all = readAll(store);
  if ((all[thread] ?? -Infinity) >= at) return;
  all[thread] = at;
  const kept = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
  try {
    store.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {}
}

export function isUnread(row: SeenRow, since: number | null): boolean {
  return since !== null && row.role !== "user" && row.at > since;
}

export function unreadSince(rows: readonly SeenRow[], seen: number | null): number | null {
  return rows.some((row) => isUnread(row, seen)) ? seen : null;
}

function windowFocused(): boolean {
  return typeof document === "undefined" || document.hasFocus();
}

export function useUnreadBoundary(thread: string, rows: readonly SeenRow[]): number | null {
  const [visit, setVisit] = useState(0);
  const key = `${visit}:${thread}`;
  const boundary = useRef<{ key: string; seen: number | null; since: number | null; settled: boolean } | null>(null);
  if (boundary.current?.key !== key) boundary.current = { key, seen: seenAt(thread), since: null, settled: false };
  const current = boundary.current;
  if (!current.settled && rows.length > 0) {
    current.since = unreadSince(rows, current.seen);
    current.settled = true;
  }
  const settled = current.settled;
  const newest = rows.reduce((latest, row) => Math.max(latest, row.at), -Infinity);

  useEffect(() => {
    if (settled && windowFocused()) markSeen(thread, newest);
  }, [thread, key, settled, newest]);

  useEffect(() => {
    const back = () => setVisit((count) => count + 1);
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, []);

  return current.since;
}
