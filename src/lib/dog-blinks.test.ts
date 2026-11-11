import { describe, expect, it } from "vitest";
import { BLINK_EVERY_MS, BLINK_MS, createBlinks } from "./dog-blinks";

function face({ paused = false }: { paused?: boolean } = {}) {
  const blinks: Array<{ duration: number }> = [];
  const eyes = { animate: (_frames: unknown, options: { duration: number }) => blinks.push(options) };
  const element = {
    hasAttribute: (name: string) => name === "data-paused" && paused,
    querySelector: (selector: string) => (selector === ".ld-dog-blink" ? eyes : null),
  } as unknown as Element;
  return { element, blinks };
}

function host({ observing = true }: { observing?: boolean } = {}) {
  const timers = new Map<number, { run: () => void; ms: number }>();
  let seen: ((entries: readonly { target: Element; isIntersecting: boolean }[]) => void) | null = null;
  const observed = new Set<Element>();
  let still = false;
  const blinks = createBlinks({
    setInterval: (run, ms) => {
      const handle = timers.size + 1;
      timers.set(handle, { run, ms });
      return handle;
    },
    clearInterval: (handle) => timers.delete(handle as number),
    ...(observing ? {
      observer: (notify) => {
        seen = notify;
        return { observe: (target) => observed.add(target), unobserve: (target) => observed.delete(target) };
      },
    } : {}),
    still: () => still,
  });
  return {
    blinks,
    timers,
    observed,
    tick: () => { for (const timer of timers.values()) timer.run(); },
    show: (target: Element, isIntersecting = true) => seen?.([{ target, isIntersecting }]),
    rest: (value: boolean) => { still = value; },
  };
}

describe("dog blinks", () => {
  it("runs one clock for every face, however many there are, and stops it when the last one goes", () => {
    const home = host();
    const faces = Array.from({ length: 80 }, () => face());
    const stops = faces.map(({ element }) => home.blinks.watch(element));
    expect([...home.timers.values()].map((timer) => timer.ms)).toEqual([BLINK_EVERY_MS]);
    for (const stop of stops.slice(1)) stop();
    expect(home.timers.size).toBe(1);
    stops[0]!();
    expect(home.timers.size).toBe(0);
    expect(home.observed.size).toBe(0);
  });

  it("blinks only the faces on screen, together, with a short one-shot animation", () => {
    const home = host();
    const shown = face();
    const below = face();
    home.blinks.watch(shown.element);
    home.blinks.watch(below.element);
    home.show(shown.element);
    home.tick();
    expect(shown.blinks).toEqual([{ duration: BLINK_MS, easing: "ease-in-out" }]);
    expect(below.blinks).toEqual([]);
    home.show(below.element);
    home.show(shown.element, false);
    home.tick();
    expect(shown.blinks).toHaveLength(1);
    expect(below.blinks).toHaveLength(1);
  });

  it("leaves paused faces alone, and every face while the window is hidden or motion is reduced", () => {
    const home = host();
    const paused = face({ paused: true });
    const awake = face();
    home.blinks.watch(paused.element);
    home.blinks.watch(awake.element);
    home.show(paused.element);
    home.show(awake.element);
    home.rest(true);
    home.tick();
    expect(awake.blinks).toEqual([]);
    home.rest(false);
    home.tick();
    expect(awake.blinks).toHaveLength(1);
    expect(paused.blinks).toEqual([]);
  });

  it("blinks every watched face where the page cannot tell what is on screen", () => {
    const home = host({ observing: false });
    const one = face();
    home.blinks.watch(one.element);
    home.tick();
    expect(one.blinks).toHaveLength(1);
  });

  it("forgets a face that left the screen for good", () => {
    const home = host();
    const gone = face();
    const stop = home.blinks.watch(gone.element);
    home.show(gone.element);
    const other = face();
    home.blinks.watch(other.element);
    stop();
    home.show(gone.element);
    home.tick();
    expect(gone.blinks).toEqual([]);
  });
});
