// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installComposerProbe, type ComposerReadiness } from "./desktop-ready-probe.ts";

let stop = () => {};
let now = 100;
const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const state = (): ComposerReadiness => ({ composerAt: null, composerUncoveredAt: null });

function composer() {
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Message Marathon");
  vi.spyOn(input, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  return input;
}

beforeEach(() => {
  document.body.replaceChildren();
  now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  stop();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("the page's composer readiness clock", () => {
  it("dates readiness when the cover leaves even if the host reads it much later", async () => {
    const perf = state();
    stop = installComposerProbe(perf);
    const cover = document.createElement("div");
    cover.setAttribute("data-launch-splash", "shown");
    document.body.append(cover, composer());
    await flush();
    expect(perf).toEqual({ composerAt: 100, composerUncoveredAt: null });
    now = 650;
    cover.remove();
    await flush();
    now = 2_500;
    expect(perf).toEqual({ composerAt: 100, composerUncoveredAt: 650 });
    document.body.append(document.createElement("div"));
    await flush();
    expect(perf.composerUncoveredAt).toBe(650);
  });

  it("records content that is already uncovered when observation starts", () => {
    document.body.append(composer());
    const perf = state();
    stop = installComposerProbe(perf);
    expect(perf).toEqual({ composerAt: 100, composerUncoveredAt: 100 });
  });

  it("does not call a hidden page ready", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.body.append(composer());
    const perf = state();
    stop = installComposerProbe(perf);
    expect(perf.composerUncoveredAt).toBeNull();
    now = 300;
    visibility.mockReturnValue("visible");
    document.body.append(document.createElement("div"));
    await flush();
    expect(perf.composerUncoveredAt).toBe(300);
  });
});
