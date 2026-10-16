import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { LimitHold, RECHECK_MS, withWaitingRuns } from "./limit-hold.ts";

const NOW = Date.parse("2026-10-15T18:00:00Z");
const MINUTE = 60_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

let dir: string;
let file: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), "laterdog-limit-hold-"));
  file = join(dir, "limit-hold.json");
});
afterEach(async () => {
  vi.useRealTimers();
  await removeTempDir(dir);
});

const saved = () => existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8")).waiting) : [];

function boot(ready: Record<string, string | undefined>) {
  const woken: Array<{ threadId: string; restored: boolean }> = [];
  const hold: LimitHold = new LimitHold({
    readyAt: (threadId) => ready[threadId],
    wake: (threadId) => { woken.push({ threadId, restored: hold.restored(threadId) }); },
    file,
  });
  return { hold, woken };
}

describe("conversations waiting on a usage limit survive a restart", () => {
  it("keeps every waiting conversation in a private file, and lets it go once it runs again", () => {
    const { hold } = boot({ "thread-1": at(30 * MINUTE), "thread-2": at(10 * MINUTE) });
    hold.hold("thread-1");
    hold.hold("thread-2");
    hold.retry("thread-3");
    expect(saved()).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    hold.release("thread-1");
    expect(saved()).toEqual(["thread-2", "thread-3"]);
    hold.hold("thread-4");
    expect(saved()).toEqual(["thread-2", "thread-3"]);
  });

  it("holds again after a restart and carries on when the limit resets, saying the run came from before", () => {
    const ready: Record<string, string | undefined> = { "thread-1": at(30 * MINUTE) };
    boot(ready).hold.hold("thread-1");
    const { hold, woken } = boot(ready);
    expect(hold.resume()).toEqual(["thread-1"]);
    expect(hold.holds("thread-1")).toBe(true);
    expect(hold.restored("thread-1")).toBe(true);
    expect(woken).toEqual([]);
    vi.advanceTimersByTime(30 * MINUTE);
    expect(woken).toEqual([{ threadId: "thread-1", restored: true }]);
    expect(hold.restored("thread-1")).toBe(false);
    expect(saved()).toEqual([]);
  });

  it("carries on at once when the reset passed while the home was asleep", () => {
    boot({ "thread-1": at(5 * MINUTE) }).hold.hold("thread-1");
    vi.setSystemTime(NOW + 2 * 60 * MINUTE);
    const { hold, woken } = boot({ "thread-1": at(5 * MINUTE) });
    hold.resume();
    expect(woken).toEqual([{ threadId: "thread-1", restored: true }]);
    expect(saved()).toEqual([]);
  });

  it("keeps a restored conversation waiting while the dog has no free slot, and forgets it once it runs", () => {
    boot({}).hold.retry("thread-1");
    const ready: Record<string, string | undefined> = {};
    const woken: string[] = [];
    const hold: LimitHold = new LimitHold({ readyAt: (threadId) => ready[threadId], wake: (threadId) => {
      woken.push(threadId);
      if (woken.length === 1) hold.retry(threadId);
      else hold.release(threadId);
    }, file });
    hold.resume();
    expect(woken).toEqual(["thread-1"]);
    expect(hold.restored("thread-1")).toBe(true);
    expect(saved()).toEqual(["thread-1"]);
    vi.advanceTimersByTime(RECHECK_MS);
    expect(woken).toEqual(["thread-1", "thread-1"]);
    expect(hold.restored("thread-1")).toBe(false);
    expect(saved()).toEqual([]);
  });

  it("starts empty from a missing or damaged file, and writes nothing without one", () => {
    writeFileSync(file, "{ not json");
    expect(boot({}).hold.resume()).toEqual([]);
    const plain = new LimitHold({ readyAt: () => at(MINUTE), wake: () => {} });
    plain.hold("thread-1");
    expect(plain.resume()).toEqual([]);
  });
});

describe("the Cloud home wakes for a waiting conversation", () => {
  it("names the soonest time a waiting conversation can run", () => {
    const { hold } = boot({ "thread-1": at(30 * MINUTE), "thread-2": at(3 * 60 * MINUTE) });
    expect(hold.nextAt()).toBeUndefined();
    hold.hold("thread-1");
    hold.hold("thread-2");
    expect(hold.nextAt()).toBe(NOW + 30 * MINUTE);
    hold.retry("thread-3");
    expect(hold.nextAt()).toBe(NOW + RECHECK_MS);
  });

  it("asks the home to wake for the earlier of a routine and a waiting conversation, and leaves a busy home alone", () => {
    expect(withWaitingRuns({ busy: false, nextAt: null }, NOW + MINUTE)).toEqual({ busy: false, nextAt: NOW + MINUTE });
    expect(withWaitingRuns({ busy: false, nextAt: NOW + 5 * MINUTE }, NOW + MINUTE)).toEqual({ busy: false, nextAt: NOW + MINUTE });
    expect(withWaitingRuns({ busy: false, nextAt: NOW + MINUTE }, NOW + 5 * MINUTE)).toEqual({ busy: false, nextAt: NOW + MINUTE });
    expect(withWaitingRuns({ busy: true, nextAt: null }, NOW + MINUTE)).toEqual({ busy: true, nextAt: null });
    expect(withWaitingRuns({ busy: false, nextAt: null }, undefined)).toEqual({ busy: false, nextAt: null });
  });
});
