// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import { STILL_WORKING_MS, useWorkingDots, workingTail } from "./working-dots";

const msg = (m: Partial<Message>): Message => ({ id: "m1", role: "bot", kind: "text", at: 10, ...m });

describe("workingTail", () => {
  it("shows nothing while the dog is idle", () => {
    expect(workingTail(false, msg({ role: "user" }), 5)).toBe("never");
  });

  it("shows the line at once while nothing from the dog has landed this turn", () => {
    expect(workingTail(true, undefined, 5)).toBe("now");
    expect(workingTail(true, msg({ role: "user" }), 5)).toBe("now");
    expect(workingTail(true, msg({ kind: "activity" }), 5)).toBe("now");
    expect(workingTail(true, msg({ turnTerminal: true }), 20)).toBe("now");
    expect(workingTail(true, msg({ kind: "digest" }), 20)).toBe("now");
  });

  it("waits after a message the dog may still follow", () => {
    expect(workingTail(true, msg({}), 5)).toBe("later");
    expect(workingTail(true, msg({}), null)).toBe("later");
  });

  it("stays hidden once the turn has ended", () => {
    expect(workingTail(true, msg({ turnTerminal: true }), 5)).toBe("never");
    expect(workingTail(true, msg({ kind: "digest" }), 5)).toBe("never");
    expect(workingTail(true, msg({ kind: "screen" }), 5)).toBe("never");
  });

  it("keeps the old rule when the server sends no start time", () => {
    expect(workingTail(true, msg({ kind: "digest" }), null)).toBe("now");
    expect(workingTail(true, msg({ turnTerminal: true }), undefined)).toBe("never");
  });
});

describe("useWorkingDots", () => {
  let root: Root;
  const Probe = (props: { busy: boolean; last: Message; since: number }) =>
    createElement("i", null, useWorkingDots(props.busy, props.last, props.since) ? "on" : "off");
  const render = (busy: boolean, last: Message) => act(() => root.render(createElement(Probe, { busy, last, since: 5 })));
  const shown = () => document.body.textContent;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("brings the line back when the dog keeps working after a message", () => {
    render(true, msg({}));
    expect(shown()).toBe("off");
    act(() => vi.advanceTimersByTime(STILL_WORKING_MS - 1));
    expect(shown()).toBe("off");
    act(() => vi.advanceTimersByTime(1));
    expect(shown()).toBe("on");
    render(true, msg({ id: "m2" }));
    expect(shown()).toBe("off");
  });

  it("never brings it back after the final answer", () => {
    render(true, msg({}));
    render(true, msg({ turnTerminal: true }));
    render(true, msg({ id: "d1", kind: "digest" }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(shown()).toBe("off");
  });

  it("drops the wait when the dog stops", () => {
    render(true, msg({}));
    render(false, msg({}));
    act(() => vi.advanceTimersByTime(STILL_WORKING_MS));
    expect(shown()).toBe("off");
  });
});
