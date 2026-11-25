// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTurnLanding } from "./use-turn-landing";

describe("turn landing lifecycle", () => {
  let root: Root;
  let scroller: HTMLDivElement;
  let transcript: HTMLDivElement;
  let content: number;
  let appliedRoom: number;
  let animationOffset: number;
  let anchorPosition: number;
  let scale: number;
  let following: { current: boolean };
  let scrollerRef: { current: HTMLDivElement };
  let transcriptRef: { current: HTMLDivElement };
  let pins: number[];
  let observers: Array<{
    connected: boolean;
    callback: ResizeObserverCallback;
    targets: Set<Element>;
  }>;

  const rect = (top: number, height: number) =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 188 * scale,
      width: 188 * scale,
    }) as DOMRect;
  const flushResize = () =>
    act(() => {
      for (const observer of observers)
        if (observer.connected && observer.targets.has(transcript))
          observer.callback([], observer as unknown as ResizeObserver);
    });
  const room = () => transcript.querySelector<HTMLElement>("[data-turn-room]")!;

  function Probe({
    active,
    turnKey = "first",
    threadKey = "dog:thread",
    firstId = "old",
    settling = false,
  }: {
    active: boolean;
    turnKey?: string;
    threadKey?: string;
    firstId?: string;
    settling?: boolean;
  }) {
    const { roomRef } = useTurnLanding({
      scrollRef: scrollerRef,
      transcriptRef,
      followingRef: following,
      setFollowing: (value) => {
        following.current = value;
      },
      threadKey,
      firstId,
      settling,
      turn: { key: turnKey, active, topInset: 52, bottomInset: 204 },
    });
    return createElement(
      Fragment,
      null,
      createElement("div", { "data-mid": "old" }, createElement("div", { "data-anchor-box": "" })),
      createElement("div", { ref: roomRef, "data-turn-room": "" }),
    );
  }
  const render = (
    active: boolean,
    turnKey = "first",
    threadKey = "dog:thread",
    firstId = "old",
    settling = false,
  ) =>
    act(() => root.render(createElement(Probe, { active, turnKey, threadKey, firstId, settling })));

  beforeEach(() => {
    content = 500;
    appliedRoom = 0;
    animationOffset = 0;
    anchorPosition = 200;
    scale = 1;
    following = { current: true };
    pins = [];
    observers = [];
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        connected = true;
        targets = new Set<Element>();
        constructor(public callback: ResizeObserverCallback) {
          observers.push(this);
        }
        observe(target: Element) {
          this.targets.add(target);
        }
        unobserve(target: Element) {
          this.targets.delete(target);
        }
        disconnect() {
          this.connected = false;
          this.targets.clear();
        }
      },
    );
    scroller = document.createElement("div");
    transcript = document.createElement("div");
    scroller.append(transcript);
    document.body.append(scroller);
    transcript.style.paddingBottom = "204px";
    scrollerRef = { current: scroller };
    transcriptRef = { current: transcript };
    Object.defineProperty(scroller, "clientHeight", { get: () => 400 });
    Object.defineProperty(scroller, "scrollHeight", { get: () => content + appliedRoom });
    scroller.scrollTop = 100;
    scroller.scrollTo = vi.fn((options: ScrollToOptions | number) => {
      const top = typeof options === "number" ? options : (options.top ?? 0);
      scroller.scrollTop = Math.max(
        0,
        Math.min(top, scroller.scrollHeight - scroller.clientHeight),
      );
      pins.push(scroller.scrollTop);
    }) as typeof scroller.scrollTo;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this === scroller) return rect(0, 400 * scale);
      if (this === transcript)
        return rect(-scroller.scrollTop * scale, (content + appliedRoom) * scale);
      if (this.hasAttribute("data-turn-room"))
        return rect((content - scroller.scrollTop) * scale, appliedRoom * scale);
      if (this.hasAttribute("data-anchor-box"))
        return rect((anchorPosition - scroller.scrollTop + animationOffset) * scale, 136 * scale);
      return rect(0, 0);
    });
    root = createRoot(transcript);
    render(false);
  });

  afterEach(() => {
    act(() => root.unmount());
    scroller.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const zoom of [1, 2])
    it("finishes opening after the reserved room is laid out at scale " + zoom, () => {
      scale = zoom;
      render(true);
      expect(room().style.height).toBe("58px");
      expect(scroller.scrollTop).toBe(100);
      flushResize();
      expect(scroller.scrollTop).toBe(100);
      appliedRoom = 58;
      flushResize();
      expect(scroller.scrollTop).toBe(158);
      const count = pins.length;
      flushResize();
      expect(pins).toHaveLength(count);
      render(true, "second");
      flushResize();
      expect(room().style.height).toBe("58px");
      expect(scroller.scrollTop).toBe(158);
    });

  it("reserves forty percent below the measured wrapped glass header", () => {
    scroller.style.scrollPaddingTop = "82px";
    render(true);
    expect(room().style.height).toBe("46px");
  });

  it("keeps the opening room during prepends when the tiny visible area contains no message", () => {
    anchorPosition = -100;
    render(true);
    appliedRoom = 58;
    flushResize();
    content += 300;
    anchorPosition += 300;
    render(true, "first", "dog:thread", "prepended");
    expect(room().style.height).toBe("58px");
    expect(scroller.scrollTop).toBe(458);
  });

  it("finishes a staged opening only after its final header and room are laid out", () => {
    render(true, "first", "dog:thread", "old", true);
    appliedRoom = 58;
    flushResize();
    expect(pins).toHaveLength(1);
    scroller.style.scrollPaddingTop = "82px";
    content += 300;
    anchorPosition += 300;
    render(true, "first", "dog:thread", "prepended", false);
    flushResize();
    expect(room().style.height).toBe("46px");
    appliedRoom = 46;
    flushResize();
    expect(scroller.scrollTop).toBe(446);
    const count = pins.length;
    flushResize();
    expect(pins).toHaveLength(count);
  });

  it("does not apply an opening pin after the turn is cancelled", () => {
    render(true);
    const count = pins.length;
    render(false);
    appliedRoom = 58;
    flushResize();
    expect(pins).toHaveLength(count);
  });

  for (const event of ["animationend", "animationcancel"])
    it("refreshes an entering row's anchor on " + event, () => {
      scale = 2;
      animationOffset = 4.08;
      render(true);
      appliedRoom = 58;
      flushResize();
      animationOffset = 0;
      act(() =>
        transcript
          .querySelector("[data-anchor-box]")!
          .dispatchEvent(new Event(event, { bubbles: true })),
      );
      const before = scroller.scrollTop;
      content += 300;
      render(false);
      expect(scroller.scrollTop).toBe(before);
    });

  it("removes both animation listeners and disconnects its observer on unmount", () => {
    const remove = vi.spyOn(transcript, "removeEventListener");
    const hookObserver = observers[0]!;
    act(() => root.unmount());
    expect(remove.mock.calls.some(([type]) => type === "animationend")).toBe(true);
    expect(remove.mock.calls.some(([type]) => type === "animationcancel")).toBe(true);
    expect(hookObserver.connected).toBe(false);
    root = createRoot(transcript);
    render(false);
  });
});
