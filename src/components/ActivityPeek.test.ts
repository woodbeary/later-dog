// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TurnPresence } from "./TurnPresence";
import { forgetHelpers, receiveHelperEvent } from "@/lib/helpers-state";
import { forgetReasoning } from "@/lib/turn-reasoning";
import type { RuntimeEvent } from "../../shared/runtime-events";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); forgetHelpers(); forgetReasoning();
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it("opens from a native button, shows reported activity and returns focus on Escape", async () => {
  receiveHelperEvent({ eventId: "a", threadId: "t", provider: "claudeAgent", createdAt: new Date().toISOString(), type: "helper.updated", helper: { id: "h", kind: "agent", label: "Checker", state: "running", startedAt: Date.now(), background: true, activity: "Reading the notes", tokens: 900, toolUses: 2 } } as RuntimeEvent);
  await act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: true, threadId: "t", label: "Checking the draft", since: Date.now(), showDelayMs: 0 })));
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
  trigger.focus();
  await act(async () => trigger.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Reading the notes");
  expect(dialog.textContent).toContain("900 tokens");
  expect(dialog.textContent).toContain("has not shared a progress summary");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("holds activity phrases for 800ms and reveals elapsed minutes after 60s", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  const draw = (label: string) => act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: true, label, since: 100_000, showDelayMs: 0 })));
  await draw("First step");
  await draw("Next step");
  await act(async () => vi.advanceTimersByTime(799));
  expect(host.textContent).toContain("First step");
  await act(async () => vi.advanceTimersByTime(1));
  expect(host.textContent).toContain("Next step");
  await act(async () => vi.advanceTimersByTime(59_200));
  expect(host.textContent).toContain("1m");
});

it("is one row: the dog and a plain rotating phrase share one button that opens the details", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  await act(async () => root.render(createElement(TurnPresence, {
    avatar: createElement("svg", { "data-testid": "dog" }),
    visible: true,
    kind: "computer",
    since: 100_000,
    showDelayMs: 0,
  })));
  const rows = host.querySelectorAll("button.thinking-row");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.querySelector('[data-testid="dog"]')).not.toBeNull();
  expect(rows[0]!.textContent).toContain("Clicking around");
  await act(async () => vi.advanceTimersByTime(6_000));
  await act(async () => vi.advanceTimersByTime(1_000));
  expect(rows[0]!.textContent).toContain("Using the computer");
});

it("lists the tool steps, the folded updates and the elapsed time when opened", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200_000);
  await act(async () => root.render(createElement(TurnPresence, {
    avatar: null,
    visible: true,
    since: 200_000 - 83_000,
    showDelayMs: 0,
    steps: [
      { id: "a", label: "Reading a file", state: "done" },
      { id: "b", label: "Using the computer", state: "running" },
    ],
    updates: ["Halfway through the notes."],
  })));
  await act(async () => host.querySelector<HTMLButtonElement>("button.thinking-row")!.click());
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector("[data-peek-steps]")!.textContent).toContain("Reading a file");
  expect(dialog.querySelector("[data-peek-steps]")!.textContent).toContain("Using the computer");
  expect(dialog.querySelector("[data-peek-updates]")!.textContent).toContain("Halfway through the notes.");
  expect(dialog.textContent).toMatch(/1m 2\ds|1:2\d/);
});

it("stays out of the way when an answer lands before it was ever shown", async () => {
  vi.useFakeTimers(); vi.setSystemTime(100_000);
  await act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: false, since: null })));
  await act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: true, since: 100_000 })));
  await act(async () => vi.advanceTimersByTime(100));
  expect(host.querySelector("button.thinking-row")).toBeNull();
  await act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: true, answering: true, since: 100_000 })));
  await act(async () => vi.advanceTimersByTime(500));
  expect(host.querySelector(".turn-presence")).toBeNull();
});
