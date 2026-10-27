import { describe, expect, it } from "vitest";
import { ClaudeTasks, HELPER_STEP_LIMIT, helperStep, mapClaudeTask } from "./claude-tasks.ts";
import type { Helper } from "../../shared/helpers.ts";

const start = { subtype: "task_started", task_id: "a", task_type: "local_agent", description: "Check the outline", is_backgrounded: true };

describe("Claude helpers", () => {
  it("collects each helper's own tool calls under it, newest last, without prompts", () => {
    const emitted: Helper[] = [];
    const tasks = new ClaudeTasks(helper => emitted.push(helper), () => 0);
    tasks.receive({ ...start, tool_use_id: "toolu_1" });
    expect(tasks.noteStep("toolu_1", helperStep("Bash", { command: "git  status", description: "Check the tree" }))).toBe(true);
    expect(tasks.noteStep("toolu_1", helperStep("Agent", { prompt: "secret plan" }))).toBe(true);
    expect(tasks.noteStep("toolu_other", helperStep("Read", { file_path: "/a" }))).toBe(false);
    expect(emitted.at(-1)?.steps).toEqual([{ tool: "Bash", summary: "Check the tree" }, { tool: "Agent" }]);
    for (let i = 0; i < HELPER_STEP_LIMIT + 5; i += 1) tasks.noteStep("toolu_1", helperStep("Read", { file_path: `/f${i}` }));
    expect(emitted.at(-1)?.steps).toHaveLength(HELPER_STEP_LIMIT);
    expect(emitted.at(-1)?.steps?.at(-1)).toEqual({ tool: "Read", summary: `/f${HELPER_STEP_LIMIT + 4}` });
  });

  it("maps foreground agents, workflow phases and usage without prompts or output paths", () => {
    expect(mapClaudeTask(undefined, { ...start, is_backgrounded: false }, 10)).toMatchObject({ kind: "agent", background: false, startedAt: 10 });
    const flow = mapClaudeTask(undefined, { ...start, task_type: "local_workflow", prompt: "private", output_file: "/private" }, 10)!;
    const progress = mapClaudeTask(flow, { task_id: "a", subtype: "task_progress", description: "Checking the draft", usage: { total_tokens: 42, tool_uses: 2, duration_ms: 40 }, workflow_progress: [{ type: "workflow_agent", agentId: "b", label: "Checker", phaseTitle: "Check", state: "progress", toolCalls: 3 }] }, 20)!;
    expect(progress).toMatchObject({ activity: "Checking the draft", tokens: 42, toolUses: 2, members: [{ id: "b", phase: "Check", state: "running", toolUses: 3 }] });
    expect(progress).not.toHaveProperty("prompt");
    expect(progress).not.toHaveProperty("output_file");
  });

  it("throttles progress but publishes state and new members immediately", () => {
    let now = 0;
    const emitted: Helper[] = [];
    const tasks = new ClaudeTasks(helper => emitted.push(helper), () => now);
    tasks.receive(start);
    tasks.receive({ subtype: "task_progress", task_id: "a", description: "Reading" });
    expect(emitted).toHaveLength(1);
    now = 750;
    tasks.receive({ subtype: "task_progress", task_id: "a", description: "Comparing" });
    tasks.receive({ subtype: "task_notification", task_id: "a", status: "completed" });
    tasks.receive(start);
    expect(emitted).toHaveLength(3);
    expect(emitted.at(-1)?.state).toBe("done");
  });

  it("continues once after all background helpers settle despite reordered snapshots and duplicates", () => {
    const tasks = new ClaudeTasks(() => {});
    tasks.receive(start);
    tasks.receive({ ...start, task_id: "b" });
    tasks.receive({ subtype: "background_tasks_changed", tasks: [] });
    expect(tasks.backgroundRunning()).toBe(false);
    tasks.receive({ subtype: "task_notification", task_id: "a", status: "completed" });
    tasks.receive({ subtype: "task_notification", task_id: "b", status: "failed" });
    expect(tasks.takeContinuation()).toBe(true);
    tasks.receive({ subtype: "task_notification", task_id: "b", status: "failed" });
    expect(tasks.takeContinuation()).toBe(false);
    tasks.receive({ ...start, task_id: "foreground", is_backgrounded: false });
    expect(tasks.backgroundRunning()).toBe(false);
    expect(tasks.stop()).toBe(1);
    expect(tasks.running()).toBe(false);
  });
});
