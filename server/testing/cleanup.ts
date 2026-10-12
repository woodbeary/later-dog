import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

export interface WaitForExitOptions {
  signal?: NodeJS.Signals;
  graceMs?: number;
}

export function waitForExit(
  child: ChildProcess | undefined,
  options: WaitForExitOptions | number = {},
): Promise<void> {
  const { signal, graceMs = 5_000 } = typeof options === "number" ? { graceMs: options } : options;

  return new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.on("close", done);

    if (signal) {
      try {
        child.kill(signal);
      } catch {}
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      timer = setTimeout(done, 2_000);
      timer.unref?.();
    }, graceMs);
    timer.unref?.();
  });
}

export async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.warn(
    `test cleanup could not remove ${dir}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
