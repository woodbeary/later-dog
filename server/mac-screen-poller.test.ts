import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacScreenPoller, macFrameFrom } from "./mac-screen-poller.ts";

afterEach(() => vi.useRealTimers());

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("the live view of a lent Mac", () => {
  it("asks for a frame every 1.5 s and sends each one on", async () => {
    vi.useFakeTimers();
    const frames: unknown[] = [];
    let asked = 0;
    const poller = createMacScreenPoller({
      capture: async () => { asked += 1; return { png: `f${asked}`, format: "jpeg" }; },
      active: () => true,
      onFrame: (frame) => frames.push(frame),
      onStop: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(asked).toBe(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(frames).toEqual([{ png: "f1", mime: "image/jpeg" }, { png: "f2", mime: "image/jpeg" }, { png: "f3", mime: "image/jpeg" }]);
    poller.stop();
  });

  it("keeps one frame in flight and skips a beat while the last one is still coming", async () => {
    vi.useFakeTimers();
    const slow = deferred<unknown>();
    let asked = 0;
    const poller = createMacScreenPoller({
      capture: () => { asked += 1; return asked === 1 ? slow.promise : Promise.resolve({ png: "x", format: "jpeg" }); },
      active: () => true,
      onFrame: () => {},
      onStop: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(4500);
    expect(asked).toBe(1);
    slow.resolve({ png: "late", format: "jpeg" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(asked).toBe(2);
    poller.stop();
  });

  it("stops by itself once the dog lets go of the Mac", async () => {
    vi.useFakeTimers();
    let holding = true;
    let asked = 0;
    const stopped = vi.fn();
    const poller = createMacScreenPoller({
      capture: async () => { asked += 1; return { png: "x", format: "jpeg" }; },
      active: () => holding,
      onFrame: () => {},
      onStop: stopped,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    holding = false;
    await vi.advanceTimersByTimeAsync(6000);
    expect(asked).toBe(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(poller.running()).toBe(false);
  });

  it("sends nothing while the person holds the Mac, and picks up again after", async () => {
    vi.useFakeTimers();
    let held = true;
    const frames: unknown[] = [];
    const poller = createMacScreenPoller({
      capture: async () => held ? { isError: true, content: [{ type: "text", text: "held by a person" }] } : { png: "back", format: "jpeg" },
      active: () => true,
      onFrame: (frame) => frames.push(frame),
      onStop: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(frames).toEqual([]);
    held = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(frames).toEqual([{ png: "back", mime: "image/jpeg" }]);
    poller.stop();
  });

  it("keeps going after a failed capture", async () => {
    vi.useFakeTimers();
    let asked = 0;
    const frames: unknown[] = [];
    const poller = createMacScreenPoller({
      capture: async () => { asked += 1; if (asked === 1) throw new Error("offline"); return { png: "ok", format: "jpeg" }; },
      active: () => true,
      onFrame: (frame) => frames.push(frame),
      onStop: () => {},
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(frames).toEqual([{ png: "ok", mime: "image/jpeg" }]);
    poller.stop();
  });

  it("accepts only a small picture", () => {
    expect(macFrameFrom({ png: "QQ==", format: "png" })).toEqual({ png: "QQ==", mime: "image/png" });
    expect(macFrameFrom({ png: "A".repeat(1_400_000), format: "jpeg" })).toBeNull();
    expect(macFrameFrom({ png: "QQ==", format: "gif" })).toBeNull();
    expect(macFrameFrom("nope")).toBeNull();
  });
});
