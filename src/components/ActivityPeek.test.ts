// @vitest-environment happy-dom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TurnPresence } from "./TurnPresence";
import { ActivityPeek } from "./ActivityPeek";
import { forgetHelpers, receiveHelperEvent } from "@/lib/helpers-state";
import { forgetReasoning, NO_REASONING } from "@/lib/turn-reasoning";
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
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
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
  const updates = dialog.querySelector<HTMLButtonElement>("[data-peek-updates] button")!;
  const detail = document.getElementById(updates.getAttribute("aria-controls")!)!;
  expect(updates.textContent).toBe("What it said along the way");
  expect(updates.getAttribute("aria-expanded")).toBe("false");
  expect(detail.hidden).toBe(true);
  await act(async () => updates.click());
  expect(updates.getAttribute("aria-expanded")).toBe("true");
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toContain("Halfway through the notes.");
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


it("keeps streamed summaries collapsed, preserves open sections during updates and resets for a new turn", async () => {
  const anchor = createRef<HTMLButtonElement>();
  const draw = (turnId: string, text: string) => act(async () => root.render(createElement(ActivityPeek, {
    label: "Checking the notes", since: null, helpers: [], anchor, onClose: vi.fn(),
    reasoning: { ...NO_REASONING, turnId, text, streamed: true, clipped: true, tokens: 1200 },
    updates: ["Checking the examples."],
  })));
  await draw("one", "A short progress summary.");
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-controls]'));
  const [updates, summary] = buttons;
  const detail = document.getElementById(summary!.getAttribute("aria-controls")!)!;
  expect(summary!.textContent).toBe("Progress summary");
  expect(detail.hidden).toBe(true);
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("1,200 thinking tokens");
  await act(async () => { updates!.click(); summary!.click(); });
  expect(detail.hidden).toBe(false);
  expect(detail.textContent).toBe("… A short progress summary.");
  await draw("one", "A short progress summary. More arrived.");
  expect(summary!.getAttribute("aria-expanded")).toBe("true");
  expect(detail.textContent).toContain("More arrived.");
  await draw("two", "Another turn.");
  expect(summary!.getAttribute("aria-expanded")).toBe("false");
  expect(updates!.getAttribute("aria-expanded")).toBe("false");
  expect(detail.hidden).toBe(true);
});

it("keeps disclosure controls in the focus loop and dismisses only an outside pointer", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(createElement(ActivityPeek, {
    label: "Checking", since: null, helpers: [], anchor: createRef<HTMLButtonElement>(), onClose,
    reasoning: NO_REASONING, updates: ["A progress update."],
  })));
  const dialog = document.querySelector('[role="dialog"]')!;
  const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
  const summary = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).at(-1)!;
  expect(document.activeElement).toBe(close);
  const backwards = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true, bubbles: true });
  await act(async () => window.dispatchEvent(backwards));
  expect(backwards.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(summary);
  const forwards = new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true });
  await act(async () => window.dispatchEvent(forwards));
  expect(forwards.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(close);
  await act(async () => dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => dialog.parentElement!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("repositions the measured panel when a disclosure expands", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("role") === "dialog") return new DOMRect(0, 0, 384, this.querySelector('button[aria-expanded="true"]') ? 240 : 100);
    return new DOMRect(100, 400, 180, 30);
  });
  const opener = document.createElement("button");
  host.append(opener);
  const anchor = { current: opener };
  await act(async () => root.render(createElement(ActivityPeek, {
    label: "Checking", since: null, helpers: [], anchor, onClose: vi.fn(),
    reasoning: { ...NO_REASONING, streamed: true, text: "Progress details." },
  })));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.style.getPropertyValue("--peek-top")).toBe("292px");
  await act(async () => dialog.querySelector<HTMLButtonElement>("button[aria-controls]")!.click());
  expect(dialog.style.getPropertyValue("--peek-top")).toBe("152px");
});

it("keeps completed, active and failed steps distinct as live results arrive", async () => {
  const anchor = createRef<HTMLButtonElement>();
  const draw = (failed: boolean) => act(async () => root.render(createElement(ActivityPeek, {
    label: "Checking", since: null, helpers: [], anchor, onClose: vi.fn(), reasoning: NO_REASONING,
    steps: [
      { id: "read", label: "Reading a file", state: "done" },
      { id: "check", label: "Running a command", state: failed ? "failed" : "running" },
    ],
  })));
  await draw(false);
  const steps = document.querySelector("[data-peek-steps]")!;
  expect(steps.querySelector('[aria-label="Done"]')).not.toBeNull();
  expect(steps.querySelector('[aria-label="Working"]')).not.toBeNull();
  await draw(true);
  expect(steps.querySelector('[aria-label="Working"]')).toBeNull();
  expect(steps.querySelector('[aria-label="Did not work"]')).not.toBeNull();
  expect(steps.querySelectorAll("li")).toHaveLength(2);
});
