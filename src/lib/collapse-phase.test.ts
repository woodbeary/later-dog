// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLAPSE_MS, useCollapsePhase, type CollapsePhase } from "./collapse-phase";

let root: Root;
let seen: CollapsePhase;

function Probe({ wanted }: { wanted: boolean }) {
  seen = useCollapsePhase(wanted);
  return null;
}

const draw = (wanted: boolean) => flushSync(() => root.render(createElement(Probe, { wanted })));
const wait = (ms: number) => flushSync(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(() => {
  flushSync(() => root.unmount());
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("opening and closing a list", () => {
  it("starts open and settled when it is open from the first draw", () => {
    draw(true);
    expect(seen).toEqual({ mounted: true, open: true, settled: true });
  });

  it("stays out of the page while closed", () => {
    draw(false);
    expect(seen.mounted).toBe(false);
  });

  it("mounts closed, opens a frame later, then settles", () => {
    draw(false);
    draw(true);
    expect(seen).toEqual({ mounted: true, open: false, settled: false });
    wait(30);
    expect(seen.open).toBe(true);
    expect(seen.settled).toBe(false);
    wait(COLLAPSE_MS);
    expect(seen).toEqual({ mounted: true, open: true, settled: true });
  });

  it("closes first and leaves the page only after the animation", () => {
    draw(true);
    draw(false);
    expect(seen).toEqual({ mounted: true, open: false, settled: false });
    wait(COLLAPSE_MS - 10);
    expect(seen.mounted).toBe(true);
    wait(20);
    expect(seen.mounted).toBe(false);
  });

  it("turns around cleanly when reopened mid-close", () => {
    draw(true);
    draw(false);
    wait(50);
    draw(true);
    wait(COLLAPSE_MS + 40);
    expect(seen).toEqual({ mounted: true, open: true, settled: true });
  });
});
