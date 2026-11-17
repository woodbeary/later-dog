// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NativeActivity, NativeRun } from "../../shared/native-runs";
import type { CloudTaskSummary } from "../../shared/cloud-task";

const state = vi.hoisted(() => ({ requests: [] as string[], pages: null as null | ((path: string) => unknown), runs: [] as unknown[], bots: [] as unknown[], jobs: [] as unknown[], activities: [] as unknown[], stopped: [] as string[], stopFails: false }));
vi.mock("@/lib/native-runs-state", () => ({ useNativeRuns: () => state.runs }));
vi.mock("@/state/store-selectors", () => ({ useStoreSelector: (select: (value: { bots: unknown[] }) => unknown) => select({ bots: state.bots }), useStoreDispatch: () => () => {} }));
vi.mock("@/lib/api", () => ({ api: async (path: string) => { state.requests.push(path); return state.pages ? state.pages(path) : { run: state.runs[0], activities: state.activities }; } }));
vi.mock("@/lib/cloud-tasks", () => ({
  dogCloudTasks: async () => state.jobs,
  refreshCloudTask: async () => {},
  stopCloudTask: async (id: string) => { state.stopped.push(id); if (state.stopFails) throw new Error("no"); },
}));

import { closeWorkPanel, openWorkPanel } from "@/lib/work-panel";
import { WorkPanel } from "./WorkPanel";

let root: Root;
let host: HTMLDivElement;
const NOW = new Date(2026, 10, 17, 9, 41).getTime();
const run: NativeRun = { id: "r1", botId: "b1", threadId: "t1", turnId: "u1", provider: "claudeAgent", revision: 1, startedAt: NOW - 17 * 60_000, state: "running", observation: "live", actors: [{ id: "parent", kind: "parent", label: "Juniper", state: "running", startedAt: NOW - 17 * 60_000 }], activityCount: 2, failureCount: 0, limitations: [], nativeActivity: true };
const activity = (id: string, label: string, minutesAgo: number, over: Partial<NativeActivity> = {}): NativeActivity => ({ id, actorId: "parent", kind: "tool", label, state: "done", startedAt: NOW - minutesAgo * 60_000, ...over });
const job = (id: string, stoppable: boolean) => ({ id, title: `Job ${id}`, conversationId: "t1", state: "running", startedAt: new Date(NOW - 6 * 60_000).toISOString(), createdAt: new Date(NOW - 6 * 60_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(), stoppable }) as unknown as CloudTaskSummary;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.documentElement.dataset.reducedMotion = "true";
  state.runs = [run]; state.bots = [{ id: "b1", name: "Juniper", color: "green", busy: true, plan: { updatedAt: 1, items: [{ text: "Add a pickup time field", status: "done" }, { text: "Check the form on a small phone", status: "in_progress" }] } }];
  state.activities = [activity("a1", "Read", 16, { subject: "order form" }), activity("a2", "Bash", 10, { subject: "Run the order form tests", state: "failed", input: "pnpm test", output: "1 failed" })];
  state.jobs = []; state.stopped = []; state.stopFails = false; state.requests = []; state.pages = null;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => { closeWorkPanel(); root.unmount(); }); host.remove(); vi.useRealTimers(); });

const panel = () => host.querySelector("[data-work-panel]");
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const mount = async (page: Parameters<typeof openWorkPanel>[0]) => {
  await act(async () => root.render(createElement(WorkPanel, { botId: "b1", botName: "Juniper" })));
  await act(async () => openWorkPanel(page));
  await settle();
};

it("renders nothing when closed and the whole column when open, never as a dialog", async () => {
  await act(async () => root.render(createElement(WorkPanel, { botId: "b1", botName: "Juniper" })));
  expect(host.innerHTML).toBe("");
  await act(async () => openWorkPanel({ kind: "work", threadId: "t1" }));
  expect(panel()!.tagName).toBe("ASIDE");
  expect(panel()!.getAttribute("role")).not.toBe("dialog");
});

it("closes on Esc and never takes focus from the composer", async () => {
  const composer = document.createElement("textarea"); document.body.append(composer); composer.focus();
  await mount({ kind: "work", threadId: "t1" });
  expect(document.activeElement).toBe(composer);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(panel()).toBeNull();
  expect(document.activeElement).toBe(composer);
  composer.remove();
});

it("shows the to-do list first, then the steps newest first, with the title of what the dog is doing", async () => {
  await mount({ kind: "work", threadId: "t1" });
  expect(host.querySelector(".work-panel-title")!.textContent).toBe("What Juniper is doing");
  expect([...host.querySelectorAll(".work-panel-section")].map(node => node.textContent)).toEqual(["To-do list", "Steps"]);
  const labels = [...host.querySelectorAll("[data-step-id]")].map(node => node.querySelector(".work-panel-step-text > span")!.textContent);
  expect(labels.slice(1)).toEqual(["Ran the order form tests", "Read the order form"]);
  expect(host.querySelector("[data-step-id='a2'] .work-panel-sub")!.textContent).toBe("Didn't work");
});

it("reserves the chevron's slot on every step, so showing it on hover moves nothing", async () => {
  await mount({ kind: "work", threadId: "t1" });
  expect(host.querySelectorAll("[data-step-id]").length).toBeGreaterThan(1);
  for (const row of host.querySelectorAll("[data-step-id]")) {
    const parts = [...row.children].map(node => node.className);
    expect(parts.at(-1)).toBe("work-panel-chevron");
    expect(parts.at(-2)).toBe("work-panel-time");
  }
});

it("opens a finished step's page with what went in and what came back, and goes back to the list", async () => {
  await mount({ kind: "work", threadId: "t1" });
  await act(async () => (host.querySelector("[data-step-id='a2']") as HTMLButtonElement).click());
  expect(host.querySelector(".work-panel-title")!.textContent).toBe("Ran the order form tests");
  expect([...host.querySelectorAll(".work-panel-detail-label > span")].map(node => node.textContent)).toEqual(["What it ran", "What came back"]);
  await act(async () => (host.querySelector(".work-panel-close") as HTMLButtonElement).click());
  expect(host.querySelector(".work-panel-title")!.textContent).toBe("What Juniper is doing");
});

it("offers Stop only on a coding job, asks first, and says when it could not stop", async () => {
  state.jobs = [job("j1", true), job("j2", false)];
  await mount({ kind: "side-jobs", threadId: "t1" });
  expect(host.querySelector(".work-panel-title")!.textContent).toBe("Side jobs");
  expect(host.querySelectorAll("[data-side-job]")).toHaveLength(2);
  expect(host.querySelector("[data-stop-job]")).toBeNull();
  await act(async () => openWorkPanel({ kind: "side-job", threadId: "t1", jobId: "job:j2" }));
  expect(host.querySelector("[data-stop-job]")).toBeNull();
  await act(async () => openWorkPanel({ kind: "side-job", threadId: "t1", jobId: "job:j1" }));
  await act(async () => (host.querySelector("[data-stop-job]") as HTMLButtonElement).click());
  expect(host.querySelector("[data-stop-confirm] p")!.textContent).toBe("Stop this job? Juniper keeps working.");
  expect(state.stopped).toEqual([]);
  state.stopFails = true;
  await act(async () => (host.querySelector("[data-stop-confirm] button[data-danger]") as HTMLButtonElement).click());
  await settle();
  expect(state.stopped).toEqual(["j1"]);
  expect(host.querySelector("[data-stop-failed]")!.textContent).toBe("Couldn't stop. Try again.");
});

it("follows the step list past its first page, so the newest of 250 steps shows", async () => {
  const all = Array.from({ length: 250 }, (_, index) => activity(`e${index}`, "Edit", 250 - index, { subject: `file ${index}` }));
  state.runs = [{ ...run, activityCount: 250 }];
  state.pages = (path: string) => {
    const from = Number(new URL(path, "http://x").searchParams.get("cursor") ?? 0);
    const page = all.slice(from, from + 200);
    return { run: state.runs[0], activities: page, ...(from + 200 < all.length ? { nextCursor: String(from + 200) } : {}) };
  };
  await mount({ kind: "work", threadId: "t1" });
  await settle(); await settle();
  expect(host.textContent).toContain("file 249");
  expect(state.requests.length).toBe(2);
});

it("asks for the steps again only when the run's steps change, not on every revision", async () => {
  await mount({ kind: "work", threadId: "t1" });
  const asked = state.requests.length;
  expect(asked).toBe(1);
  state.runs = [{ ...run, revision: 7 }];
  await act(async () => root.render(createElement(WorkPanel, { botId: "b1", botName: "Juniper" })));
  await settle();
  expect(state.requests.length).toBe(asked);
  state.runs = [{ ...run, revision: 8, activityCount: 3 }];
  await act(async () => root.render(createElement(WorkPanel, { botId: "b1", botName: "Juniper" })));
  await settle();
  expect(state.requests.length).toBe(asked + 1);
});

it("closes when the person switches to another dog, so one dog's steps never show under another's name", async () => {
  await mount({ kind: "work", threadId: "t1" });
  expect(panel()).not.toBeNull();
  await act(async () => root.render(createElement(WorkPanel, { botId: "b2", botName: "Pepper" })));
  await settle();
  expect(panel()).toBeNull();
});

it("stays on Stopping after a stop that went through, until the job is finished", async () => {
  state.jobs = [job("j1", true)];
  await mount({ kind: "side-job", threadId: "t1", jobId: "job:j1" });
  await act(async () => (host.querySelector("[data-stop-job]") as HTMLButtonElement).click());
  await act(async () => (host.querySelector("[data-stop-confirm] button[data-danger]") as HTMLButtonElement).click());
  await settle();
  expect(state.stopped).toEqual(["j1"]);
  expect(host.querySelector("[data-stopping]")).not.toBeNull();
  expect(host.querySelector("[data-stop-job]")).toBeNull();
});

it("opens the live step's page when its row is clicked", async () => {
  state.runs = [{ ...run, activityCount: 3, currentActivity: { id: "a3", actorId: "parent", kind: "tool", label: "Bash", state: "running", startedAt: NOW - 60_000 } }];
  state.activities = [...state.activities, activity("a3", "Bash", 1, { state: "running", subject: "Run the tests", input: "pnpm test" })];
  await mount({ kind: "work", threadId: "t1" });
  await act(async () => (host.querySelector("[data-live]") as HTMLButtonElement).click());
  expect(panel()!.getAttribute("data-page")).toBe("step");
  expect(host.textContent).toContain("pnpm test");
});
