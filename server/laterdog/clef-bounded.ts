export interface BoundedMapOptions {
  max: number;
  ttlMs?: number;
  now?: () => number;
}

export function createBoundedMap<V>(options: BoundedMapOptions) {
  const now = options.now ?? Date.now;
  const rows = new Map<string, { value: V; at: number }>();

  const expired = (at: number) => options.ttlMs !== undefined && now() - at > options.ttlMs;

  return {
    get(key: string): V | undefined {
      const row = rows.get(key);
      if (!row) return undefined;
      if (expired(row.at)) {
        rows.delete(key);
        return undefined;
      }
      return row.value;
    },
    set(key: string, value: V): void {
      rows.delete(key);
      rows.set(key, { value, at: now() });
      while (rows.size > options.max) rows.delete(rows.keys().next().value as string);
    },
    delete(key: string): void {
      rows.delete(key);
    },
    sweep(keep: (key: string) => boolean): void {
      for (const [key, row] of rows) if (expired(row.at) || !keep(key)) rows.delete(key);
    },
    get size(): number {
      return rows.size;
    },
  };
}

export type BoundedMap<V> = ReturnType<typeof createBoundedMap<V>>;
