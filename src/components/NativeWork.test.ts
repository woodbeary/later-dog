// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRun, NativeRunDetail } from "../../shared/native-runs";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
vi.mock("./Avatar", () => ({ DogAvatar: ({ label }: { label: string }) => createElement("span", null, label) }));
const { api } = await import("@/state/store");
const { NativeWork, NativeWorkFallbacks, actorAncestry, nativePuppies } = await import("./NativeWork");
const { forgetNativeRuns } = await import("@/lib/native-runs-state");

function run(): NativeRun {
  return { id: "run", threadId: "thread", turnId: "turn", provider: "claudeAgent", providerVersion: "2.1.293", revision: 1, startedAt: 100, state: "running", observation: "live", actors: [{ id: "parent", kind: "parent", label: "Main", state: "running", startedAt: 100 }, ...Array.from({ length: 7 }, (_, index) => ({ id: `child-${index}`, parentId: index === 1 ? "child-0" : "parent", kind: "subagent" as const, label: `Researcher ${index}`, state: index === 2 ? "failed" as const : "running" as const, startedAt: 101, canStop: index === 1 })), { id: "shell", kind: "task", label: "Test command", state: "running", startedAt: 102 }], activityCount: 2, failureCount: 1, limitations: ["Individual native tasks cannot be stopped separately on this backend."] };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.mocked(api).mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); forgetNativeRuns(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("native work", () => {
  it("shows at most five selectable puppies plus overflow without turning shell tasks into puppies", async () => {
    await act(async () => root.render(createElement(NativeWork, { run: run(), live: true })));
    expect(host.querySelectorAll('button[aria-label^="View Researcher"]')).toHaveLength(5);
    expect(host.querySelector('button[aria-label="View 2 more puppies"]')).not.toBeNull();
    expect(nativePuppies(run())).toHaveLength(7);
  });

  it("opens the selected puppy with ancestry, recorded search links and its supported stop action", async () => {
    const data = run();
    const detail: NativeRunDetail = { run: data, activities: [{ id: "search", actorId: "child-1", kind: "search", label: "Search official documentation", state: "done", startedAt: 110, text: "Found the source", links: [{ title: "Official source", url: "https://example.com/docs" }] }] };
    vi.mocked(api).mockResolvedValue(detail);
    await act(async () => root.render(createElement(NativeWork, { run: data, live: true })));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label^="View Researcher 1"]')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Researcher 0");
    expect(dialog.textContent).toContain("Found the source");
    expect(dialog.querySelector('a[href="https://example.com/docs"]')).not.toBeNull();
    const stop = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Stop helper")!;
    vi.mocked(api).mockResolvedValueOnce({ status: "requested" });
    await act(async () => stop.click());
    expect(api).toHaveBeenCalledWith("/api/threads/thread/runs/run/actors/child-1/stop", { method: "POST" });
    expect(stop.textContent).toBe("Stop requested");
    expect(stop.disabled).toBe(true);
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps a completed receipt available and shows harness limits without an unsupported stop button", async () => {
    const data = { ...run(), state: "done" as const, observation: "partial" as const, endedAt: 300 };
    vi.mocked(api).mockResolvedValue({ run: data, activities: [] });
    await act(async () => root.render(createElement(NativeWork, { run: data })));
    const receipt = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("View work"))!;
    await act(async () => receipt.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Claude Code 2.1.293");
    expect(dialog.textContent).toContain("Partial activity");
    expect(dialog.textContent).toContain("Individual native tasks cannot be stopped separately");
    expect(dialog.textContent).not.toContain("Stop helper");
  });

  it("bounds ancestry traversal when a provider supplies a cycle", () => {
    const data = run();
    data.actors[0]!.parentId = "child-1";
    expect(actorAncestry(data, data.actors[2]!)).toHaveLength(2);
  });

  it("keeps interrupted work with no answer or end timestamp discoverable", async () => {
    const interrupted = { ...run(), observation: "interrupted" as const };
    await act(async () => root.render(createElement(NativeWorkFallbacks, { runs: [interrupted], messages: [] })));
    expect(host.textContent).toContain("View work");
    expect(host.textContent).toContain("Interrupted");
  });

  it("uses native search evidence for the active label", async () => {
    const data = { ...run(), currentActivity: { id: "search", actorId: "child-1", kind: "search" as const, label: "WebSearch", state: "running" as const } };
    await act(async () => root.render(createElement(NativeWork, { run: data, live: true, label: "Thinking" })));
    expect(host.textContent).toContain("Searching");
    expect(host.textContent).not.toContain("Thinking");
  });

  it("refreshes every loaded activity page when the run advances", async () => {
    vi.useFakeTimers();
    let data = run();
    vi.mocked(api).mockImplementation(async (path) => path.includes("cursor=later") ? { run: data, activities: [{ id: "late", actorId: "parent", kind: "tool", label: "Later tool", state: data.revision > 1 ? "done" : "running", startedAt: 200, output: data.revision > 1 ? "Latest result" : "Waiting" }] } : { run: data, activities: [], nextCursor: "later" });
    await act(async () => root.render(createElement(NativeWork, { run: data })));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("View work"))!.click());
    const more = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === "Load more activity") as HTMLButtonElement;
    await act(async () => more.click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Waiting");
    data = { ...data, revision: 2 };
    await act(async () => root.render(createElement(NativeWork, { run: data })));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Latest result");
  });
});
