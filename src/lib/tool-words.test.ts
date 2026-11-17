// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import type { NativeRun, NativeRunDetail } from "../../shared/native-runs";

vi.mock("@/state/store", () => ({ api: vi.fn() }));
const { api } = await import("@/state/store");
const { NativeWork } = await import("@/components/NativeWork");
const { ToolActivity } = await import("@/components/ToolActivity");
const { ActivityRun } = await import("@/components/ActivityRun");
const { describeRun } = await import("./activity-runs");
const { plainToolLabel } = await import("./tool-words");

const RAW = [
  "mcp__agents__run_on_computer", "mcp__agents__coordinate_bots", "mcp__agents__create_bot", "mcp__agents__memory_update",
  "mcp__agents__set_plan", "mcp__agents__list_bots", "mcp__laterdog__send_email", "mcp__some_server__brand_new_thing",
  "Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebSearch", "WebFetch", "TodoWrite", "Task", "ToolSearch", "AskUserQuestion",
  "run_on_computer", "apply_patch", "web_search", "exec_command", "some_unknown_tool", "AnotherUnknownTool",
  "Bash: pnpm test", "mcp__agents__run_on_computer: bash lanes/check.sh",
];

const internal = /__|\bmcp\b|\b[a-z]+_[a-z_]+\b|\b(?:Bash|TodoWrite|WebFetch|WebSearch|ToolSearch|AskUserQuestion)\b/;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); vi.mocked(api).mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("tools named in plain words", () => {
  it("gives every tool a plain phrase, running or done, and a generic one for a tool nobody named", () => {
    for (const name of RAW) {
      for (const running of [true, false]) {
        const said = plainToolLabel(name, running);
        expect(said, name).not.toMatch(internal);
        expect(said, name).toMatch(/^[A-Z]/);
      }
    }
    expect(plainToolLabel("mcp__agents__run_on_computer", true)).toBe("Running a command on its computer");
    expect(plainToolLabel("mcp__some_server__brand_new_thing", false)).toBe("Used a tool");
    expect(plainToolLabel("Bash: pnpm test", false)).toBe("Ran a command: pnpm test");
  });

  it("leaves words that are already plain as they are", () => {
    expect(plainToolLabel("GitHub", false)).toBe("GitHub");
    expect(plainToolLabel("Search official documentation", true)).toBe("Search official documentation");
    expect(plainToolLabel("Researcher 2", false)).toBe("Researcher 2");
  });

  it("never puts an internal name beside the dog's face while it works, nor in its work details", async () => {
    const run: NativeRun = {
      id: "run", threadId: "thread", turnId: "turn", provider: "claudeAgent", revision: 1, startedAt: 100, state: "running", observation: "live",
      actors: [{ id: "parent", kind: "parent", label: "Main", state: "running", startedAt: 100 }], activityCount: 2, failureCount: 0, limitations: [],
      currentActivity: { id: "a2", actorId: "parent", kind: "tool", label: "mcp__agents__run_on_computer", state: "running" },
    };
    await act(async () => root.render(createElement(NativeWork, { run, live: true })));
    expect(host.textContent).toContain("Running a command on its computer");
    expect(host.textContent).not.toMatch(internal);
    const detail: NativeRunDetail = { run, activities: [
      { id: "a1", actorId: "parent", kind: "tool", label: "mcp__agents__coordinate_bots", state: "done", startedAt: 101 },
      { id: "a2", actorId: "parent", kind: "tool", label: "mcp__agents__run_on_computer", state: "running", startedAt: 102 },
    ] };
    vi.mocked(api).mockResolvedValue(detail);
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Asked other dogs");
    expect(dialog.textContent).toContain("Running a command on its computer");
    expect(dialog.textContent).not.toMatch(internal);
  });

  it("names steps plainly in the step list and in each step's row", () => {
    const step = (name: string, ok?: boolean): Message => ({ id: name, role: "bot", kind: "activity", at: 1, tool: { name, ...(ok === undefined ? {} : { ok }) } });
    const steps = [step("mcp__agents__run_on_computer", true), step("mcp__agents__run_on_computer", true), step("Bash", true), step("mcp__x__y_z", true)];
    expect(describeRun(steps)).not.toMatch(internal);
    expect(describeRun(steps)).toContain("Ran a command on its computer ×2");
    const run = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(run).not.toMatch(internal);
    const row = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "mcp__agents__run_on_computer", ok: undefined, summary: "bash lanes/check.sh" } }));
    expect(row).toContain("Running a command on its computer");
    expect(row.replace(/<pre[\s\S]*?<\/pre>/g, "")).not.toContain("mcp__");
  });

  it("leaves no internal name anywhere: a step opened with no input, a dotted engine name, an error that quotes one, and a helper's latest tool", async () => {
    expect(plainToolLabel("functions.exec_command", false)).toBe("Ran a command");
    expect(plainToolLabel("Error: mcp__agents__run_on_computer timed out", false)).toBe("Error: a tool timed out");
    expect(plainToolLabel("Running mcp__claude_ai_Gmail__search_threads", true)).toBe("Running a tool");
    const opened = renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "mcp__agents__run_on_computer", ok: false } }));
    expect(opened).not.toMatch(internal);
    expect(renderToStaticMarkup(createElement(ToolActivity, { tool: { name: "functions.exec_command", ok: true } }))).not.toMatch(internal);
    const { ActivityPeek } = await import("@/components/ActivityPeek");
    const { NO_REASONING } = await import("./turn-reasoning");
    const { createRef } = await import("react");
    await act(async () => root.render(createElement(ActivityPeek, {
      label: "Checking", since: null, anchor: createRef<HTMLButtonElement>(), onClose: vi.fn(), reasoning: NO_REASONING, updates: [],
      helpers: [{ id: "h", label: "Look through the mail", state: "running", startedAt: 1, activity: "mcp__claude_ai_Gmail__search_threads", recentActivity: ["mcp__agents__run_on_computer", "now"] }],
    } as never)));
    expect(document.body.textContent).toContain("Look through the mail");
    expect(document.body.textContent).not.toMatch(internal);
  });
});

