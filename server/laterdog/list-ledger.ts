import { existsSync, readFileSync } from "node:fs";

import { writeFileAtomic } from "../atomic.ts";

export interface ListLedger<T> {
  read(): T[];
  write(entries: T[]): void;
}

export function fileListLedger<T>(path: string, isEntry: (value: unknown) => value is T): ListLedger<T> {
  return {
    read() {
      if (!existsSync(path)) return [];
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
      } catch {
        return [];
      }
    },
    write(entries) {
      writeFileAtomic(path, `${JSON.stringify(entries)}\n`, { mode: 0o600, durable: false });
    },
  };
}
