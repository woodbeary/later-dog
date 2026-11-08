import { readdir, stat } from "node:fs/promises";

type Target = { dev: number; ino: number };

export async function ownFileIsUnopened(target: Target): Promise<boolean> {
  const started = Date.now();
  let count = 0;
  try {
    for (const fd of await readdir("/proc/self/fd")) {
      if (++count > 50_000 || Date.now() - started > 2000) return false;
      try {
        const info = await stat("/proc/self/fd/" + fd);
        if (info.dev === target.dev && info.ino === target.ino) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    return true;
  } catch { return false; }
}

export function listenForArchiveOwnership(): void {
  process.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type !== "archive.ownership" || typeof value.id !== "string" || value.id.length > 128) return;
    const target = value.target as Target | undefined;
    if (!target || !Number.isSafeInteger(target.dev) || !Number.isSafeInteger(target.ino)) return;
    void ownFileIsUnopened(target).then(unopened => {
      try { process.send?.({ type: "archive.ownership.result", id: value.id, unopened }); } catch {}
    });
  });
  process.channel?.unref();
}
