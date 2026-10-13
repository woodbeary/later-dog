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
  await act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: true, threadId: "t", label: "Checking the draft", since: Date.now() })));
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
  const draw = (label: string) => act(async () => root.render(createElement(TurnPresence, { avatar: null, visible: true, label, since: 100_000 })));
  await draw("First step");
  await draw("Next step");
  await act(async () => vi.advanceTimersByTime(799));
  expect(host.textContent).toContain("First step");
  await act(async () => vi.advanceTimersByTime(1));
  expect(host.textContent).toContain("Next step");
  await act(async () => vi.advanceTimersByTime(59_200));
  expect(host.textContent).toContain("1m");
});
