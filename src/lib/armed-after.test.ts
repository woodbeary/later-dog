// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useArmedAfter } from "./activity-presence";

let root: Root;
let armed = false;

function Probe({ wanted, delay }: { wanted: boolean; delay?: number }) {
  armed = useArmedAfter(wanted, delay);
  return null;
}

const draw = (wanted: boolean, delay?: number) => flushSync(() => root.render(createElement(Probe, { wanted, delay })));
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

describe("the working row never flashes for a fast send", () => {
  it("waits before showing when work starts while you watch", () => {
    draw(false, 300);
    draw(true, 300);
    expect(armed).toBe(false);
    wait(299);
    expect(armed).toBe(false);
    wait(1);
    expect(armed).toBe(true);
  });

  it("never shows at all when the answer lands inside the wait", () => {
    draw(false, 300);
    draw(true, 300);
    wait(150);
    draw(false, 300);
    wait(500);
    expect(armed).toBe(false);
  });

  it("goes away the moment the work ends", () => {
    draw(false, 300);
    draw(true, 300);
    wait(300);
    expect(armed).toBe(true);
    draw(false, 300);
    expect(armed).toBe(false);
  });

  it("shows at once when a thread that is already busy opens", () => {
    draw(true, 300);
    expect(armed).toBe(true);
  });
});
