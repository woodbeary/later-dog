// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ api: vi.fn(async () => ({ fetchedAt: "", providers: [] })) }));
vi.mock("@/state/store", () => ({ api: fixture.api }));

const { usePlanUsage, useRefreshAfterTurn } = await import("./PlanUsage");

const NOW = Date.UTC(2026, 9, 9, 12);
function Reader() {
  usePlanUsage();
  return null;
}
function Turn({ busy }: { busy: boolean }) {
  useRefreshAfterTurn(busy);
  return null;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const mount = () => {
  const container = document.createElement("div");
  document.body.append(container);
  return createRoot(container);
};

afterEach(() => vi.useRealTimers());

describe("refreshing usage after a turn", () => {
  it("checks again when a turn ends, at most every 30 seconds, and only while usage is on screen", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
    const reader = mount();
    flushSync(() => reader.render(createElement(Reader)));
    expect(fixture.api).toHaveBeenCalledTimes(1);
    await settle();

    const turn = mount();
    const end = () => {
      flushSync(() => turn.render(createElement(Turn, { busy: true })));
      flushSync(() => turn.render(createElement(Turn, { busy: false })));
    };
    end();
    expect(fixture.api).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 31_000);
    end();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    expect(fixture.api).toHaveBeenLastCalledWith("/api/plan-usage");
    await settle();

    flushSync(() => reader.unmount());
    vi.setSystemTime(NOW + 120_000);
    end();
    expect(fixture.api).toHaveBeenCalledTimes(2);
    flushSync(() => turn.unmount());
  });
});
