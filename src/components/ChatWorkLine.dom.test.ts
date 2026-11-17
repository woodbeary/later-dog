// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import type { NativeRun } from "../../shared/native-runs";
import { liveStep, stepPhrase } from "../../shared/step-words";
import { ChatWorkLine } from "./TurnPresence";
import { closeWorkPanel, useWorkPanel } from "@/lib/work-panel";
import { forgetNativeRuns, receiveNativeRun } from "@/lib/native-runs-state";

let root: Root;
let host: HTMLDivElement;
let opened: unknown = null;
function PanelProbe() {
  opened = useWorkPanel();
  return null;
}

const bot = { id: "juniper", threadId: "jt", name: "Juniper", color: "green", busy: true, messages: [] } as unknown as Bot;
const run = (fields: Partial<NativeRun> = {}): NativeRun => ({
  id: "run-1", threadId: "jt", turnId: "turn-1", botId: "juniper", provider: "fake", revision: 1, startedAt: 0, state: "running",
  observation: "live", actors: [{ id: "parent", kind: "parent", label: "Juniper", state: "running", startedAt: 0 }],
  activityCount: 2, failureCount: 0, limitations: [],
  currentActivity: { id: "act-3", actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: 0 },
  ...fields,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  vi.useFakeTimers({ now: 0 });
  forgetNativeRuns();
  closeWorkPanel();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const draw = (props: Partial<Parameters<typeof ChatWorkLine>[0]> = {}) => act(() => root.render(createElement("div", null,
  createElement(ChatWorkLine, { bot, working: true, onOpenDog: () => {}, ...props }),
  createElement(PanelProbe),
)));

it("says the live step's phrase, the same words the panel's live row and the sidebar take from it", () => {
  const live = run();
  receiveNativeRun(live);
  draw();
  const step = liveStep(live)!;
  expect(host.querySelector("[data-work-line-phrase]")?.textContent).toBe(stepPhrase(step.kind, step.id));
  expect(host.querySelector("[data-work-line]")?.textContent).toBe(stepPhrase(step.kind, step.id));
});

it("keeps the phrase while the step id stays and adds the age at one minute", () => {
  receiveNativeRun(run());
  draw();
  const phrase = host.querySelector("[data-work-line-phrase]")?.textContent;
  act(() => { vi.advanceTimersByTime(59_000); });
  receiveNativeRun(run({ revision: 2, lastActivityAt: 59_000 }));
  draw();
  expect(host.querySelector("[data-work-line-phrase]")?.textContent).toBe(phrase);
  expect(host.querySelector("[data-work-line]")?.textContent).not.toContain("for");
  act(() => { vi.advanceTimersByTime(1_000); });
  expect(host.querySelector("[data-work-line]")?.textContent).toBe(`${phrase} · for 1 min`);
});

it("opens the panel at what the dog is doing, and at its side jobs from the side jobs", () => {
  receiveNativeRun(run({ actors: [
    { id: "parent", kind: "parent", label: "Juniper", state: "running", startedAt: 0 },
    { id: "bg1", parentId: "parent", kind: "task", label: "Check", state: "running", startedAt: 0, background: true },
    { id: "bg2", parentId: "parent", kind: "task", label: "Look", state: "running", startedAt: 0, background: true },
  ] }));
  draw();
  const sideJobs = host.querySelector<HTMLButtonElement>("[data-work-line-side-jobs]")!;
  expect(sideJobs.textContent).toBe(" · 2 side jobs");
  act(() => sideJobs.click());
  expect(opened).toEqual({ kind: "side-jobs", threadId: "jt" });
  act(() => host.querySelector<HTMLButtonElement>("[data-work-line] button")!.click());
  expect(opened).toEqual({ kind: "work", threadId: "jt" });
});

it("opens the helper's chat when a helper needs an answer", () => {
  const onOpenDog = vi.fn();
  draw({ bot: { ...bot, work: { kind: "waiting-on-dog", dogs: [{ id: "otis", name: "Otis", ask: "Which photo?" }] } } as Bot, onOpenDog });
  const line = host.querySelector<HTMLButtonElement>("[data-work-line] button")!;
  expect(line.textContent).toBe("Otis needs your answer");
  act(() => line.click());
  expect(onOpenDog).toHaveBeenCalledWith("otis");
  expect(opened).toBeNull();
});

it("shows nothing when the dog is not working", () => {
  receiveNativeRun(run());
  draw({ working: false });
  expect(host.querySelector("[data-work-line]")).toBeNull();
});
