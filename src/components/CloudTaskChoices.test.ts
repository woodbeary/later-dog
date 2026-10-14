// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Message } from "@/state/store";
import type { CloudTaskSummary } from "../../shared/cloud-task";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: fixture.dispatch }), api: fixture.api }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/components/DesktopCapabilities", () => ({ useCaptionChrome: () => ({ padClass: "" }) }));
vi.mock("@/lib/cloud-tasks", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/cloud-tasks")>(),
  useCloudTaskActivity: () => ({ steps: [], available: false, live: false, loading: false }),
}));
import { modelLabel, rememberCloudTasks, runsWithLabel, traceKeptUntil } from "@/lib/cloud-tasks";
import { CloudTaskCard } from "./CloudTaskCard";
import { CloudTaskPanel } from "./CloudTaskPanel";

let host: HTMLDivElement;
let root: Root;
let next = 0;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

function remember(patch: Partial<CloudTaskSummary>): string {
  next += 1;
  const id = `22222222-3333-4444-8555-${String(next).padStart(12, "0")}`;
  rememberCloudTasks([{ id, title: "Fix the login button", state: "ready", backend: "laterdog-cloud", repository: "owner/repo", kind: "implementation",
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z", outputBranch: "laterdog/x", screen: false, stoppable: false, publishable: false, ...patch }]);
  return id;
}
const card = (id: string) => {
  const message: Message = { id: `card-${id}`, role: "bot", kind: "activity", at: 1, tool: { name: "Cloud task: Fix the login button", ok: true }, cloudTask: { jobId: id, title: "Fix the login button", repository: "owner/repo", backend: "laterdog-cloud" } } as Message;
  act(() => root.render(createElement(CloudTaskCard, { message })));
};
const panel = (id: string) => act(() => root.render(createElement(CloudTaskPanel, { jobId: id })));
const SOON = new Date(Date.now() + 20 * 86_400_000).toISOString();

describe("what a cloud job runs with, in plain words", () => {
  it("names a model the way a person says it", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
    expect(modelLabel("claude-sonnet-5-5[1m]")).toBe("Sonnet 5.5");
    expect(modelLabel("opus")).toBe("Opus");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Opus 4.1");
  });

  it("joins the model and effort, and says nothing when neither was chosen", () => {
    expect(runsWithLabel({ model: "claude-opus-5-5", effort: "high" } as CloudTaskSummary)).toBe("Opus 5.5 · High");
    expect(runsWithLabel({ effort: "max" } as CloudTaskSummary)).toBe("Max");
    expect(runsWithLabel({} as CloudTaskSummary)).toBeNull();
    expect(runsWithLabel(undefined)).toBeNull();
    expect(traceKeptUntil({ trace: { bytes: 1, truncated: false, expiresAt: "2026-11-13T12:00:00.000Z" } } as CloudTaskSummary)).toMatch(/2026/);
    expect(traceKeptUntil({} as CloudTaskSummary)).toBeNull();
  });
});

describe("the job card", () => {
  it("shows the model and effort beside the project, and a link to save the trace", () => {
    const id = remember({ model: "claude-opus-5-5", effort: "high", account: "Work Claude", trace: { bytes: 2048, truncated: false, expiresAt: SOON } });
    card(id);
    expect(host.querySelector("[data-cloud-task-runs-with]")?.textContent).toBe("Opus 5.5 · High");
    expect(host.textContent).toContain("repo");
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    expect(host.querySelector("a[download]")).toBeNull();
    const save = host.querySelector<HTMLButtonElement>(`button[aria-label="Save the full trace of Fix the login button"]`)!;
    expect(save).not.toBeNull();
  });

  it("saves the trace through an authenticated fetch and says so when the supervisor refuses", async () => {
    const id = remember({ trace: { bytes: 2048, truncated: false, expiresAt: SOON } });
    card(id);
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    const fetched = vi.fn(async () => new Response('{"type":"result"}\n', { status: 200 }));
    const created = vi.fn(() => "blob:trace");
    const revoked = vi.fn();
    vi.stubGlobal("fetch", fetched);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked }));
    const save = host.querySelector<HTMLButtonElement>("button[aria-label^='Save the full trace']")!;
    await act(async () => { save.click(); });
    expect(fetched).toHaveBeenCalledWith(`/api/laterdog/jobs/${id}/trace`);
    expect(created).toHaveBeenCalledTimes(1);
    fetched.mockImplementation(async () => Response.json({ error: "This job's trace expired 2026-01-01." }, { status: 410 }));
    await act(async () => { save.click(); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This job's trace expired 2026-01-01.");
    vi.unstubAllGlobals();
  });

  it("shows no trace link and no choices when none were kept or made", () => {
    const id = remember({});
    card(id);
    expect(host.querySelector("[data-cloud-task-runs-with]")).toBeNull();
    act(() => { host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click(); });
    expect(host.querySelector("button[aria-label^='Save the full trace']")).toBeNull();
  });
});

describe("the job panel", () => {
  it("lists the account, model, effort and computer, and offers the trace with how long it is kept", () => {
    const id = remember({ model: "claude-opus-5-5", effort: "xhigh", account: "Work Claude", computerSize: "large", trace: { bytes: 9000, truncated: true, expiresAt: SOON } });
    panel(id);
    const choices = host.querySelector('[data-testid="cloud-task-choices"]')!.textContent!;
    expect(choices).toContain("AccountWork Claude");
    expect(choices).toContain("ModelOpus 5.5");
    expect(choices).toContain("EffortxHigh");
    expect(choices).toContain("ComputerLarge");
    expect(host.querySelector("a[download]")).toBeNull();
    expect(host.querySelector("button[aria-label^='Save the full trace']")).not.toBeNull();
    expect(host.textContent).toMatch(/kept until/);
    expect(host.textContent).toMatch(/cut because the record was over 64 MB/);
  });

  it("leaves the choices out when the job runs with its defaults", () => {
    panel(remember({}));
    expect(host.querySelector('[data-testid="cloud-task-choices"]')).toBeNull();
    expect(host.querySelector("button[aria-label^='Save the full trace']")).toBeNull();
  });
});
