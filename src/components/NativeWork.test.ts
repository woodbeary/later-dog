// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeRun, NativeRunDetail } from "../../shared/native-runs";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
const puppiesDrawn = vi.hoisted(() => ({ count: 0 }));
vi.mock("./Avatar", () => ({ DogAvatar: ({ label }: { label: string }) => { puppiesDrawn.count += 1; return createElement("span", null, label); } }));
const { api } = await import("@/state/store");
const { NativeWork, NativeWorkFallbacks, actorAncestry, nativePuppies } = await import("./NativeWork");
const { currentNativeRuns, forgetNativeRuns } = await import("@/lib/native-runs-state");

function run(): NativeRun {
  return { id: "run", threadId: "thread", turnId: "turn", provider: "claudeAgent", providerVersion: "2.1.293", revision: 1, startedAt: 100, state: "running", observation: "live", actors: [{ id: "parent", kind: "parent", label: "Main", state: "running", startedAt: 100 }, ...Array.from({ length: 7 }, (_, index) => ({ id: `child-${index}`, parentId: index === 1 ? "child-0" : "parent", kind: "subagent" as const, label: `Researcher ${index}`, state: index === 2 ? "failed" as const : "running" as const, startedAt: 101, canStop: index === 1 })), { id: "shell", kind: "task", label: "Test command", state: "running", startedAt: 102 }], activityCount: 2, failureCount: 1, limitations: ["Individual native tasks cannot be stopped separately on this backend."] };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.mocked(api).mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); forgetNativeRuns(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("native work", () => {
  it("shows at most five selectable puppies plus overflow without turning shell tasks into puppies", async () => {
    await act(async () => root.render(createElement(NativeWork, { run: { ...run(), failureCount: 3 }, live: true })));
    expect(host.querySelectorAll('button[aria-label^="View Researcher"]')).toHaveLength(5);
    expect(host.querySelector('button[aria-label="View 2 more helpers"]')).not.toBeNull();
    expect(nativePuppies(run())).toHaveLength(7);
    expect(host.textContent).toContain("Issue recorded");
    expect(host.textContent).not.toContain("3 issues");
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

  it("refreshes an unconfirmed stop after fifteen seconds and retries only on an explicit action", async () => {
    vi.useFakeTimers();
    let data = run();
    let resolveRefresh: ((detail: NativeRunDetail) => void) | undefined;
    let reads = 0;
    vi.mocked(api).mockImplementation(async (_path, options) => {
      if (options?.method === "POST") return { status: "requested" };
      reads++;
      if (reads === 2) return new Promise<NativeRunDetail>(resolve => { resolveRefresh = resolve; });
      return { run: data, activities: [] };
    });
    await act(async () => root.render(createElement(NativeWork, { run: data, live: true })));
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label^="View Researcher 1"]')!.click());
    const button = () => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => /^(Stop helper|Stop requested|Try stop again)$/.test(node.textContent ?? ""));
    const posts = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST");
    await act(async () => button()!.click());
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(button()!.textContent).toBe("Stop requested");
    expect(button()!.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(button()!.textContent).toBe("Try stop again");
    expect(button()!.disabled).toBe(false);
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("The stop hasn't been confirmed");
    expect(reads).toBe(2);
    expect(posts()).toHaveLength(1);
    expect(data.actors.find(actor => actor.id === "child-1")?.state).toBe("running");
    await act(async () => button()!.click());
    expect(posts()).toHaveLength(2);
    await act(async () => resolveRefresh!({ run: { ...data, revision: 2, actors: data.actors.map(actor => actor.id === "child-1" ? { ...actor, state: "stopped", canStop: false } : actor) }, activities: [] }));
    expect(button()!.textContent).toBe("Stop requested");
    expect(currentNativeRuns(data.threadId)[0]?.revision).toBe(1);
    data = { ...data, revision: 2, actors: data.actors.map(actor => actor.id === "child-1" ? { ...actor, state: "stopped", canStop: false } : actor) };
    await act(async () => root.render(createElement(NativeWork, { run: data, live: true })));
    expect(button()).toBeUndefined();
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain("The stop hasn't been confirmed");
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(posts()).toHaveLength(2);
  });

  it("shows running execution against the current selection without claiming the turn moved", async () => {
    const data = { ...run(), providerInstanceId: "claude-a", actors: run().actors.map(actor => actor.id === "parent" ? { ...actor, model: "opus" } : actor) };
    vi.mocked(api).mockResolvedValue({ run: data, activities: [] } satisfies NativeRunDetail);
    await act(async () => root.render(createElement(NativeWork, { run: data, live: true, selection: { instanceId: "claude-a", model: "sonnet" } })));
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const line = dialog.querySelector("[data-native-execution]")!;
    expect(line.getAttribute("data-native-execution")).toBe("next-message");
    expect(line.textContent).toContain("Running on opus");
    expect(line.textContent).toContain("sonnet · claude-a, applies to the next message");
    expect(dialog.textContent).toContain("Work given to another dog carries on in that dog's own chat");
  });

  it("omits the execution line when no selection is supplied", async () => {
    vi.mocked(api).mockResolvedValue({ run: run(), activities: [] } satisfies NativeRunDetail);
    await act(async () => root.render(createElement(NativeWork, { run: run(), live: true })));
    await act(async () => host.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']")!.click());
    expect(document.querySelector("[data-native-execution]")).toBeNull();
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

  it("redraws a work row when its run is replaced by a newer one, and leaves it alone while the same run is handed back", async () => {
    const data = run();
    const row = (current: NativeRun) => createElement("div", null, createElement(NativeWork, { run: current, live: true, label: "Thinking" }));
    await act(async () => root.render(row(data)));
    const drawnAtFirst = puppiesDrawn.count;
    expect(host.querySelector('button[aria-label="View Researcher 0 · Working"]')).not.toBeNull();

    await act(async () => root.render(row(data)));
    expect(puppiesDrawn.count).toBe(drawnAtFirst);

    const advanced = { ...data, revision: 2, actors: data.actors.map(actor => actor.id === "child-0" ? { ...actor, state: "done" as const } : actor) };
    await act(async () => root.render(row(advanced)));
    expect(puppiesDrawn.count).toBeGreaterThan(drawnAtFirst);
    expect(host.querySelector('button[aria-label="View Researcher 0 · Done"]')).not.toBeNull();
    expect(host.querySelector('button[aria-label="View Researcher 0 · Working"]')).toBeNull();
  });

  it("says each step in plain words and keeps tool names and the engine behind closed details", async () => {
    const data = { ...run(), state: "done" as const, observation: "complete" as const, endedAt: 300, actors: [{ id: "parent", kind: "parent" as const, label: "Pepper", state: "done" as const, startedAt: 100 }, { id: "child", parentId: "parent", kind: "subagent" as const, label: "Researcher", state: "done" as const, startedAt: 101 }] };
    vi.mocked(api).mockResolvedValue({ run: data, activities: [
      { id: "bash", actorId: "parent", kind: "tool", label: "Bash", state: "done", startedAt: 110, input: "{\"command\":\"ls\"}" },
      { id: "todo", actorId: "parent", kind: "tool", label: "TodoWrite", state: "done", startedAt: 111 },
      { id: "said", actorId: "parent", kind: "message", label: "Message", state: "done", startedAt: 112, text: "All added up" },
    ] } satisfies NativeRunDetail);
    await act(async () => root.render(createElement(NativeWork, { run: data })));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("View work"))!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const shown = (node: Element): string => node.tagName === "DETAILS" ? node.querySelector("summary")?.textContent ?? "" : [...node.childNodes].map(child => child.nodeType === 1 ? shown(child as Element) : child.textContent ?? "").join(" ");
    const visible = shown(dialog);
    expect(visible).toContain("Ran a command");
    expect(visible).toContain("Made a plan");
    expect(visible).toContain("Wrote the reply");
    expect(visible).toContain("Technical details");
    for (const word of ["Bash", "TodoWrite", "Message", "Claude Code", "agent", "task", "reported", "Recorded", "Main"]) expect(visible).not.toContain(word);
    expect(dialog.querySelector('nav[aria-label="Your dog and its helpers"]')!.textContent).toContain("Helper · Done");
    expect(dialog.textContent).toContain("Bash");
  });

  it("refreshes every loaded activity page when the run advances", async () => {
    vi.useFakeTimers();
    let data = run();
    vi.mocked(api).mockImplementation(async (path) => path.includes("cursor=later") ? { run: data, activities: [{ id: "late", actorId: "parent", kind: "tool", label: "Later tool", state: data.revision > 1 ? "done" : "running", startedAt: 200, output: data.revision > 1 ? "Latest result" : "Waiting" }] } : { run: data, activities: [], nextCursor: "later" });
    await act(async () => root.render(createElement(NativeWork, { run: data })));
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("View work"))!.click());
    const more = [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === "Show more") as HTMLButtonElement;
    await act(async () => more.click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Waiting");
    data = { ...data, revision: 2 };
    await act(async () => root.render(createElement(NativeWork, { run: data })));
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain("Latest result");
  });
});
