import { useRef } from "react";

type Row = { id: string; role: string };

export function newBelowCount(rows: readonly Row[], anchorId: string | null): number {
  if (!anchorId) return 0;
  const index = rows.findIndex((row) => row.id === anchorId);
  if (index < 0) return 0;
  return rows.slice(index + 1).filter((row) => row.role !== "user").length;
}

export function useNewBelow(following: boolean, rows: readonly Row[]): number {
  const anchor = useRef<string | null>(null);
  if (following || anchor.current === null) anchor.current = rows.at(-1)?.id ?? null;
  return following ? 0 : newBelowCount(rows, anchor.current);
}
