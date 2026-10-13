import { expect, it } from "vitest";
import { CodexHelpers } from "./codex-helpers.ts";
import type { Helper } from "../../shared/helpers.ts";

it("uses parent-reported helper states, names and explicit resumed generations without copying prompts", () => {
  const events: Helper[] = [];
  const helpers = new CodexHelpers(event => events.push(event), () => 100);
  helpers.receive({ type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", receiverThreadIds: ["a"], prompt: "private prompt", agentsStates: { a: { status: "running", message: "private result" } } });
  helpers.receive({ type: "subAgentActivity", agentThreadId: "a", agentPath: "/root/checker", kind: "started" });
  helpers.receive({ type: "collabAgentToolCall", tool: "wait", status: "completed", receiverThreadIds: ["a"], agentsStates: { a: { status: "completed" } } });
  helpers.receive({ type: "subAgentActivity", agentThreadId: "a", agentPath: "/root/checker", kind: "interacted" });
  expect(events.at(-1)).toMatchObject({ state: "done", label: "checker", id: "codex:a:0" });
  helpers.receive({ type: "collabAgentToolCall", tool: "followupTask", status: "completed", receiverThreadIds: ["a"], agentsStates: { a: { status: "running" } } });
  expect(events.at(-1)).toMatchObject({ state: "running", id: "codex:a:1" });
  expect(helpers.stop()).toBe(1);
  expect(events.at(-1)?.state).toBe("stopped");
  expect(JSON.stringify(events)).not.toContain("private");
});
