import { steadyDisk, STEADY_WINDOW_MS } from "./archive-pressure.ts";
import type { DiskUse } from "./janitor.ts";

export const FLOOR_SAMPLE_MS = 5_000;

export interface SteadyFloor {
  reading(): DiskUse | null;
  stop(): void;
}

export function startSteadyFloor(read: () => DiskUse | null, options: { everyMs?: number; windowMs?: number; now?: () => number } = {}): SteadyFloor {
  const reading = steadyDisk(read, () => 0, { windowMs: options.windowMs ?? STEADY_WINDOW_MS, now: options.now });
  const timer = setInterval(() => { reading(); }, options.everyMs ?? FLOOR_SAMPLE_MS);
  timer.unref();
  return { reading, stop: () => clearInterval(timer) };
}
