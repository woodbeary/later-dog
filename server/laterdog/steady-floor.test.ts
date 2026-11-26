import { afterEach, describe, expect, it, vi } from "vitest";
import { STEADY_WINDOW_MS } from "./archive-pressure.ts";
import { homeFloorDecision } from "./disk-floor.ts";
import type { DiskUse } from "./janitor.ts";
import { FLOOR_SAMPLE_MS, startSteadyFloor } from "./steady-floor.ts";

const GB = 1024 ** 3;
const TOTAL = 20 * GB;
const free = (share: number): DiskUse => ({ totalBytes: TOTAL, freeBytes: share * TOTAL });
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
const refused = (disk: DiskUse | null) => homeFloorDecision(bash("pnpm install"), disk, { computers: true }) !== null;

function savingEveryMinute(nowMs: () => number): () => DiskUse {
  return () => free(nowMs() % 60_000 < 45_000 ? 0.084 : 0.113);
}

describe("the steady reading behind shell refusals", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("gives the same answer all minute while a save swings free space across the refuse line", () => {
    vi.useFakeTimers({ now: 0 });
    const raw = savingEveryMinute(() => Date.now());
    const floor = startSteadyFloor(raw);
    vi.advanceTimersByTime(STEADY_WINDOW_MS);
    const rawAnswers = new Set<boolean>();
    const steadyAnswers = new Set<boolean>();
    for (let second = 0; second < 180; second += 1) {
      vi.advanceTimersByTime(1_000);
      rawAnswers.add(refused(raw()));
      steadyAnswers.add(refused(floor.reading()));
    }
    floor.stop();
    expect(rawAnswers).toEqual(new Set([true, false]));
    expect(steadyAnswers).toEqual(new Set([false]));
  });

  it("samples on its own between shell calls, so a short calm stretch nobody asked about still counts", () => {
    vi.useFakeTimers({ now: 0 });
    let share = 0.113;
    const floor = startSteadyFloor(() => free(share));
    vi.advanceTimersByTime(FLOOR_SAMPLE_MS);
    share = 0.084;
    vi.advanceTimersByTime(STEADY_WINDOW_MS - 2 * FLOOR_SAMPLE_MS);
    expect(refused(floor.reading())).toBe(false);
    vi.advanceTimersByTime(2 * FLOOR_SAMPLE_MS);
    expect(refused(floor.reading())).toBe(true);
    floor.stop();
  });

  it("refuses once the disk has stayed short for the whole window, and subtracts nothing", () => {
    vi.useFakeTimers({ now: 0 });
    const floor = startSteadyFloor(() => free(0.098));
    expect(floor.reading()).toEqual(free(0.098));
    expect(refused(floor.reading())).toBe(true);
    floor.stop();
  });

  it("says nothing about a disk it cannot read", () => {
    const floor = startSteadyFloor(() => null);
    expect(floor.reading()).toBeNull();
    expect(refused(floor.reading())).toBe(false);
    floor.stop();
  });
});
