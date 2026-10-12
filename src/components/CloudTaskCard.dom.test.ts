// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import type { CloudTaskStep, CloudTaskSummary } from "../../shared/cloud-task";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  openExternalLink: vi.fn(async () => {}),
  api: vi.fn(),
  steps: vi.fn(),
  summaries: new Map<string, unknown>(),
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.openExternalLink }));
// The progress log's own paging is the panel's and is tested there; the card only shows what it returns.
vi.mock("@/lib/cloud-tasks", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/cloud-tasks")>(), useCloudTaskActivity: fixture.steps }));
import { rememberCloudTasks } from "@/lib/cloud-tasks";
import { CloudTaskCard } from "./CloudTaskCard";

const PR = "https://github.com/owner/repo/pull/12";
const STEPS: CloudTaskStep[] = [
  { t: 1, k: "stage", stage: "clone" },
  { t: 2, k: "tool", tool: "Edit", detail: "src/login.tsx" },
  { t: 3, k: "tool", tool: "Bash", detail: "pnpm test" },
];

let host: HTMLDivElement;
let root: Root;
let next = 0;

/** A card for a job in the given state, under a fresh id so the shared task cache never leaks between tests. */
function mount(patch: Partial<CloudTaskSummary>): string {
  next += 1;
  const id = `11111111-2222-4333-8444-${String(next).padStart(12, "0")}`;
  const summary: CloudTaskSummary = {
    id, title: "Fix the login button", state: "running", stage: "claude", backend: "laterdog-cloud", repository: "owner/repo", kind: "implementation",
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z", outputBranch: "laterdog/x", screen: true, stoppable: true, publishable: false, ...patch,
  };
  fixture.summaries.set(id, summary);
  rememberCloudTasks([summary]);
  const message: Message = { id: `card-${id}`, role: "bot", kind: "activity", at: 1, tool: { name: "Cloud task: Fix the login button", ok: true }, cloudTask: { jobId: id, title: "Fix the login button", repository: "owner/repo" } };
  act(() => root.render(createElement(CloudTaskCard, { message })));
  return id;
}

const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const settle = () => act(async () => { for (let tick = 0; tick < 5; tick += 1) await Promise.resolve(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.steps.mockImplementation(() => ({ steps: STEPS, available: true, live: true, loading: false }));
  fixture.api.mockImplementation(async (path: string) => {
    const ids = /^\/api\/laterdog\/jobs\?ids=(.+)$/.exec(path)?.[1];
    if (ids) return { jobs: ids.split(",").flatMap((id) => (fixture.summaries.has(id) ? [fixture.summaries.get(id)] : [])) };
    if (path.endsWith("/action")) return {};
    throw new Error(`unexpected request ${path}`);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.dispatch.mockReset();
  fixture.openExternalLink.mockClear();
  fixture.api.mockReset();
  fixture.steps.mockReset();
});

describe("a cloud task card's steps", () => {
  it("are read only once asked for, and list what the task did in plain words in a box that keeps its height", () => {
    const id = mount({});
    const toggle = button("Steps for Fix the login button")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[data-cloud-task-steps]")).toBeNull();
    expect(fixture.steps).not.toHaveBeenCalled();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    // read live, because the task is still at work
    expect(fixture.steps).toHaveBeenCalledWith(id, true);
    const list = host.querySelector<HTMLOListElement>('ol[aria-label="Steps"]')!;
    expect([...list.querySelectorAll("li")].map((row) => [...row.children].map((part) => part.textContent))).toEqual([
      ["Getting the code"], ["Changed a file", "src/login.tsx"], ["Ran a command", "pnpm test"],
    ]);
    expect(list.style.height).toBe("132px");
    act(() => toggle.click());
    expect(host.querySelector("[data-cloud-task-steps]")).toBeNull();
  });

  it("say why a task needs the person, and keep the same box while the first steps load", () => {
    fixture.steps.mockImplementation(() => ({ steps: [], available: false, live: true, loading: true }));
    mount({ state: "needs_attention", blocker: "The job exited 1 during setup", stoppable: false, screen: false });
    act(() => button("Steps for Fix the login button")!.click());
    expect(host.querySelector("[data-cloud-task-steps]")?.textContent).toContain("The job exited 1 during setup");
    const list = host.querySelector<HTMLOListElement>('ol[aria-label="Steps"]')!;
    expect(list.textContent).toBe("Loading the steps…");
    expect(list.style.height).toBe("132px");
  });

  it("offer Stop while the task can be stopped, and say so plainly when it could not", async () => {
    const id = mount({});
    act(() => button("Steps for Fix the login button")!.click());
    act(() => button("Stop Fix the login button")!.click());
    await settle();
    expect(fixture.api).toHaveBeenCalledWith(`/api/laterdog/jobs/${id}/action`, { method: "POST", body: JSON.stringify({ action: "cancel" }) });
    expect(host.querySelector('[role="alert"]')).toBeNull();

    const answer = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/action")) throw new Error("The supervisor said no");
      return answer(path, init);
    });
    act(() => button("Stop Fix the login button")!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't stop. Try again.");
  });

  it("show no Stop once the task is over", () => {
    mount({ state: "ready", changes: { files: 1, additions: 1, deletions: 0 }, stoppable: false, screen: false });
    act(() => button("Steps for Fix the login button")!.click());
    expect(fixture.steps.mock.calls.at(-1)?.[1]).toBe(false);
    expect(button("Stop Fix the login button")).toBeNull();
  });
});

describe("a cloud task card's one button", () => {
  it("opens a working task beside the chat", () => {
    const id = mount({});
    act(() => button("Open Fix the login button")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudTask", jobId: id });
  });

  it("opens the draft on GitHub to review it, with the task itself one step away under Steps", () => {
    const id = mount({ state: "ready", prUrl: PR, prNumber: 12, changes: { files: 3, additions: 40, deletions: 2 }, stoppable: false, screen: false });
    act(() => button("Review changes: Fix the login button")!.click());
    expect(fixture.openExternalLink).toHaveBeenCalledWith(PR);
    expect(fixture.dispatch).not.toHaveBeenCalled();
    act(() => button("Steps for Fix the login button")!.click());
    act(() => button("Open Fix the login button")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudTask", jobId: id });
  });

  it("opens the changes beside the chat when there is no draft yet, where Publish waits", () => {
    const id = mount({ state: "ready", publishable: true, changes: { files: 2, additions: 5, deletions: 1 }, stoppable: false, screen: false });
    act(() => button("Review changes: Fix the login button")!.click());
    expect(fixture.openExternalLink).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "openCloudTask", jobId: id });
  });
});
