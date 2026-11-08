import { lstat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const threadLogPaths = (id: string) => {
  if (!/^[\w-]{8,200}$/.test(id)) throw new Error("invalid archive thread");
  return [`.laterdog/events/${id}.ndjson`, `.laterdog/native/${id}.ndjson`];
};

export type LogArchiveBridge = {
  archive(paths: string[]): Promise<{ archived: number; bytes: number }>;
  restore(paths: string[]): Promise<void>;
};

export function logArchiveBridge(url: string, token: string): LogArchiveBridge {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
    throw new Error("archive service must use loopback");
  }
  const call = async (path: string, paths: string[]) => {
    const response = await fetch(new URL(path, endpoint), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ paths }), signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`archive service refused: ${response.status}`);
    return await response.json() as { archived: number; bytes: number; failed?: number };
  };
  return {
    archive: paths => call("archive", paths),
    async restore(paths) {
      const result = await call("restore-logs", paths);
      if (result.failed !== 0) throw new Error("saved logs are not restored yet");
    },
  };
}

type Options = {
  root: string;
  bridge: LogArchiveBridge;
  threads(): string[];
  idle(threadId: string): boolean;
  now?: () => number;
  ageMs?: number;
  byteLimit?: number;
  threadLimit?: number;
  retryMs?: number;
  report?(message: string): void;
};

export class LogArchiveCoordinator {
  private gates = new Map<string, Promise<unknown>>();
  private scanning: Promise<void> | null = null;
  private cursor = 0;
  private totals = { archivedFiles: 0, archivedBytes: 0, lastScanAt: null as number | null, freeBefore: null as number | null, freeAfter: null as number | null };
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.report = options.report ?? (() => {});
  }

  private async gate<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.gates.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.gates.set(id, next);
    try { return await next; }
    finally { if (this.gates.get(id) === next) this.gates.delete(id); }
  }

  async beforeTurn(id: string, current: () => boolean): Promise<boolean> {
    let warned = false;
    while (current()) {
      try {
        return await this.gate(id, async () => {
          if (!current()) return false;
          await this.options.bridge.restore(threadLogPaths(id));
          return current();
        });
      } catch {
        if (!warned) this.report("saved logs unavailable; keeping the pending turn and retrying");
        warned = true;
        await delay(this.options.retryMs ?? 5000);
      }
    }
    return false;
  }

  read<T>(id: string, action: () => T): Promise<T> {
    return this.gate(id, async () => {
      await this.options.bridge.restore(threadLogPaths(id));
      return action();
    });
  }

  readMany<T>(ids: string[], action: () => T): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    const next = (at: number): Promise<T> => at === ordered.length
      ? Promise.resolve(action())
      : this.gate(ordered[at], async () => {
        await this.options.bridge.restore(threadLogPaths(ordered[at]));
        return next(at + 1);
      });
    return next(0);
  }

  status() { return { enabled: true, ...this.totals }; }

  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.sweep().finally(() => { this.scanning = null; });
    return this.scanning;
  }

  private async sweep(): Promise<void> {
    const { root, bridge, idle, threads } = this.options;
    const known = threads();
    const maximum = Math.min(known.length, this.options.threadLimit ?? 100);
    const age = this.options.ageMs ?? 24 * 60 * 60_000;
    let remaining = this.options.byteLimit ?? 64 * 1024 * 1024;
    let archived = 0;
    let bytes = 0;
    const free = async () => {
      const disk = await statfs(root);
      return disk.bavail * disk.bsize;
    };
    const before = await free();
    this.totals.freeBefore = before;
    this.totals.lastScanAt = this.now();
    for (let count = 0; count < maximum && remaining > 0; count++) {
      const id = known[this.cursor++ % known.length];
      if (!idle(id)) continue;
      await this.gate(id, async () => {
        if (!idle(id)) return;
        const paths: string[] = [];
        for (const path of threadLogPaths(id)) {
          const info = await lstat(join(root, path)).catch(() => null);
          if (!info?.isFile() || info.isSymbolicLink() || this.now() - info.mtimeMs < age || info.size > remaining) continue;
          remaining -= info.size;
          paths.push(path);
        }
        if (!paths.length || !idle(id)) return;
        const result = await bridge.archive(paths);
        archived += result.archived;
        bytes += result.bytes;
        this.totals.archivedFiles += result.archived;
        this.totals.archivedBytes += result.bytes;
      });
    }
    this.totals.freeAfter = await free();
    if (archived) this.report(`archived ${archived} logs / ${bytes} bytes; free disk ${before} -> ${await free()} bytes`);
  }
}
