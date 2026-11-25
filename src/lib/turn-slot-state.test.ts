import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRun } from "../../shared/native-runs";
import { useTurnSlotLine } from "./turn-slot-state";

let browser: Window;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  browser = new Window({ url: "http://localhost" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", browser.document);
  vi.stubGlobal("navigator", browser.navigator);
  vi.stubGlobal("HTMLElement", browser.HTMLElement);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  browser.happyDOM.abort();
  vi.unstubAllGlobals();
});

function run(stepId: string, startedAt: number): NativeRun {
  return {
    id: "turn-one", threadId: "thread", turnId: "one", provider: "fixture", revision: startedAt + 1,
    startedAt: 0, state: "running", observation: "live", actors: [], activityCount: 1,
    failureCount: 0, limitations: [],
    currentActivity: { id: stepId, actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt, subject: "Run the order form tests" },
  };
}

function Probe({ current }: { current: NativeRun }) {
  const { line } = useTurnSlotLine({ name: "Scout", working: true, turnKey: "one", since: 0, run: current });
  return createElement("output", { "data-age": line?.age ?? "" }, line?.words ?? "");
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("the live turn clock", () => {
  it("updates the kind's elapsed minute even when a replacement step started fifty seconds later", () => {
    act(() => root.render(createElement(Probe, { current: run("first", 0) })));
    advance(300);
    const generic = host.textContent;
    advance(49_700);
    act(() => root.render(createElement(Probe, { current: run("second", 50_000) })));
    advance(9_999);
    expect(host.querySelector("output")?.getAttribute("data-age")).toBe("");
    advance(1);
    expect(host.textContent).toBe(generic);
    expect(host.querySelector("output")?.getAttribute("data-age")).toBe("for 1 min");
    advance(49_999);
    expect(host.textContent).toBe(generic);
    advance(1);
    expect(host.textContent).toBe(generic);
    advance(1_000);
    expect(host.textContent).toBe("Running the order form tests");
    expect(host.querySelector("output")?.getAttribute("data-age")).toBe("for 1 min");
  });
});
