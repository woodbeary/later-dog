import { afterEach, describe, expect, it, vi } from "vitest";

import { whenSeen } from "./when-seen";

type Watch = (entries: Array<{ isIntersecting: boolean }>) => void;

const fakeObserver = () => {
  const made: Array<{ watch: Watch; observed: unknown[]; disconnected: boolean }> = [];
  class FakeIntersectionObserver {
    record: { watch: Watch; observed: unknown[]; disconnected: boolean };
    constructor(watch: Watch) {
      this.record = { watch, observed: [], disconnected: false };
      made.push(this.record);
    }
    observe(element: unknown) {
      this.record.observed.push(element);
    }
    disconnect() {
      this.record.disconnected = true;
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return made;
};

afterEach(() => vi.unstubAllGlobals());

describe("whenSeen", () => {
  it("waits until the element scrolls into view, then runs once and stops watching", () => {
    const made = fakeObserver();
    const element = {} as Element;
    const seen = vi.fn();
    whenSeen(element, seen);
    expect(seen).not.toHaveBeenCalled();
    expect(made[0]?.observed).toEqual([element]);
    made[0]?.watch([{ isIntersecting: false }]);
    expect(seen).not.toHaveBeenCalled();
    made[0]?.watch([{ isIntersecting: true }]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(made[0]?.disconnected).toBe(true);
  });

  it("stops watching when released before it was seen", () => {
    const made = fakeObserver();
    const seen = vi.fn();
    const release = whenSeen({} as Element, seen);
    release();
    expect(made[0]?.disconnected).toBe(true);
    expect(seen).not.toHaveBeenCalled();
  });

  it("runs straight away where nothing can watch for it", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const seen = vi.fn();
    whenSeen({} as Element, seen);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
