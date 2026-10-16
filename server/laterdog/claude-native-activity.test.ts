import { describe, expect, it } from "vitest";
import type { NativeObservation } from "../../shared/native-runs.ts";
import { ClaudeNativeActivity, claudeSearchLinks } from "./claude-native-activity.ts";

function fixture() {
  const observations: NativeObservation[] = [];
  const native = new ClaudeNativeActivity(observation => observations.push(observation), { version: "2.1.293", sessionId: "session", now: () => 100 });
  const actors = () => observations.flatMap(row => row.kind === "actor" ? [row.actor] : []);
  const activities = () => observations.flatMap(row => row.kind === "activity" ? [row.activity] : []);
  const latestActor = (nativeId: string) => actors().filter(actor => actor.nativeId === nativeId).at(-1)!;
  return { native, observations, actors, activities, latestActor };
}

const start = (task = "agent-a", run = "run-01", extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "task_started", task_id: task, run_id: run, task_type: "local_agent", tool_use_id: `spawn-${task}-${run}`, description: "Check the sources", spawn_depth: 1, ...extra });
const assistant = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: "assistant", uuid, message: { id: `message-${uuid}`, content }, ...extra });

describe("Claude native activity", () => {
  it("correlates nested child transcripts, reasoning and searches with their task runs", () => {
    const f = fixture();
    f.native.receive(start());
    const parent = f.latestActor("agent-a");
    f.native.receive(start("agent-b", "run-01", { parent_task_id: "agent-a", spawn_depth: 2, prompt: "Check official documentation against the implementation." }));
    const child = f.latestActor("agent-b");
    expect(child).toMatchObject({ parentId: parent.id, kind: "subagent", generation: "run-01", state: "running" });
    const scope = { agent_id: "agent-b", parent_tool_use_id: "spawn-agent-b-run-01" };
    f.native.receive(assistant("child", [{ type: "thinking", thinking: "Compare official sources" }, { type: "text", text: "I found the specification" }, { type: "tool_use", id: "search", name: "WebSearch", input: { query: "native session protocol" } }], scope));
    f.native.receive({ type: "user", uuid: "search-result", ...scope, message: { content: [{ type: "tool_result", tool_use_id: "search", content: [{ type: "text", text: "Found it" }] }] }, tool_use_result: { query: "native session protocol", results: [{ content: [{ title: "Specification", url: "https://example.com/spec" }] }] } });
    expect(f.activities()).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: child.id, kind: "reasoning", text: "Compare official sources" }),
      expect.objectContaining({ actorId: child.id, kind: "message", text: "I found the specification" }),
      expect.objectContaining({ actorId: child.id, kind: "search", state: "done", links: [{ title: "Specification", url: "https://example.com/spec" }] }),
    ]));
    expect(f.native.actorForRequest({ toolUseId: "search" })).toBe(child.id);
    expect(f.activities().some(activity => activity.actorId === "parent")).toBe(false);
    f.native.receive({ type: "system", subtype: "task_progress", task_id: "agent-b", run_id: "run-01", description: "Reading the specification" });
    expect(f.latestActor("agent-b")).toMatchObject({ task: "Check official documentation against the implementation.", activity: "Reading the specification" });
  });

  it("uses the SDK-guaranteed lexical run order to open resumes and ignore older-run state", () => {
    const f = fixture();
    f.native.receive(start());
    const first = f.latestActor("agent-a").id;
    f.native.receive({ type: "system", subtype: "task_notification", task_id: "agent-a", run_id: "run-01", status: "completed" });
    f.native.receive(start("agent-a", "run-02"));
    const second = f.latestActor("agent-a");
    expect(second.id).not.toBe(first);
    expect(second).toMatchObject({ state: "running", generation: "run-02" });
    expect(second.endedAt).toBeUndefined();
    f.native.receive({ type: "system", subtype: "task_notification", task_id: "agent-a", run_id: "run-01", status: "failed" });
    expect(f.latestActor("agent-a")).toEqual(second);
    f.native.receive(assistant("late-message", [{ type: "text", text: "Previous run detail" }], { agent_id: "agent-a", parent_tool_use_id: "spawn-agent-a-run-01" }));
    expect(f.activities().at(-1)?.actorId).toBe(first);
  });

  it("keeps agent_id-only messages uncertain because persistent agent identity does not identify their run", () => {
    const f = fixture();
    f.native.receive(start());
    f.native.receive(assistant("uncertain", [{ type: "text", text: "Native child detail" }], { agent_id: "agent-a" }));
    const uncertain = f.actors().at(-1)!;
    expect(uncertain.id).not.toBe(f.actors()[0]!.id);
    expect(uncertain.activity).toContain("attribution unavailable");
    expect(f.activities().at(-1)?.actorId).toBe(uncertain.id);
  });

  it("deduplicates wrapper UUIDs without dropping distinct blocks sharing a model message ID", () => {
    const f = fixture();
    const one = { ...assistant("one", [{ type: "text", text: "First block" }]), message: { id: "same", content: [{ type: "text", text: "First block" }] } };
    f.native.receive(one);
    f.native.receive(one);
    f.native.receive({ ...one, uuid: "two", message: { id: "same", content: [{ type: "text", text: "Second block" }] } });
    expect(f.activities().map(row => row.text)).toEqual(["First block", "Second block"]);
    expect(new Set(f.activities().map(row => row.id)).size).toBe(2);
  });

  it("reconciles streamed parent reasoning with its final block and retains withheld reasoning as unavailable", () => {
    const f = fixture();
    const send = (event: unknown) => f.native.receive({ type: "stream_event", event });
    send({ type: "message_start", message: { id: "message" } });
    send({ type: "content_block_start", index: 0, content_block: { type: "thinking" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking " } });
    send({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "results" } });
    send({ type: "content_block_stop", index: 0 });
    f.native.receive({ type: "assistant", uuid: "final", message: { id: "message", content: [{ type: "thinking", thinking: "Checking results" }, { type: "redacted_thinking", data: "never-render-this" }] } });
    const reasoning = f.activities().filter(row => row.text === "Checking results");
    expect(new Set(reasoning.map(row => row.id)).size).toBe(1);
    expect(reasoning.at(-1)?.state).toBe("done");
    expect(f.activities().at(-1)?.label).toBe("Thinking unavailable");
    expect(JSON.stringify(f.observations)).not.toContain("never-render-this");
  });

  it("separates paused, killed and non-agent task identities and does not invent snapshot outcomes", () => {
    const f = fixture();
    f.native.receive(start("shell", "01", { task_type: "local_bash", is_backgrounded: false }));
    expect(f.latestActor("shell").kind).toBe("task");
    f.native.receive({ type: "system", subtype: "task_updated", task_id: "shell", run_id: "01", patch: { status: "paused", is_backgrounded: true } });
    expect(f.latestActor("shell")).toMatchObject({ state: "paused", background: true });
    f.native.receive({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "shell", run_id: "01", task_type: "local_bash" }] });
    f.native.receive({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(f.actors().at(-1)).toMatchObject({ state: "waiting", activity: expect.stringContaining("outcome not reported") });
    f.native.receive({ type: "system", subtype: "task_updated", task_id: "shell", run_id: "01", patch: { status: "killed" } });
    expect(f.latestActor("shell").state).toBe("stopped");
    f.native.receive(start("shell", "01", { task_type: "local_bash" }));
    expect(f.latestActor("shell").state).toBe("stopped");
  });

  it("keeps startup failures, retries and hook progress observable", () => {
    const f = fixture();
    f.native.receive({ type: "system", subtype: "init", uuid: "init", model: "test", plugin_errors: [{ plugin: "review", message: "Dependency missing" }], mcp_server_errors: [{ name: "search", message: "Invalid config" }] });
    f.native.receive({ type: "system", subtype: "api_retry", uuid: "retry", attempt: 2, retry_delay_ms: 100, error: "overloaded" });
    f.native.receive({ type: "system", subtype: "hook_started", uuid: "hook-start", hook_id: "h1", hook_name: "SessionStart" });
    f.native.receive({ type: "system", subtype: "hook_response", uuid: "hook-finish", hook_id: "h1", hook_name: "SessionStart", exit_code: 1, stderr: "Hook failed" });
    expect(f.activities().filter(row => row.state === "failed")).toHaveLength(3);
    expect(new Set(f.activities().filter(row => row.kind === "hook").map(row => row.id)).size).toBe(1);
    expect(f.activities().find(row => row.label === "Claude retry 2")?.state).toBe("waiting");
  });

  it("preserves native workflow agents and task usage without claiming total tokens are output tokens", () => {
    const f = fixture();
    f.native.receive(start("workflow", "01", { task_type: "local_workflow", workflow_progress: [{ type: "workflow_agent", agentId: "checker", label: "Checker", state: "running", phaseTitle: "Review", lastToolName: "Read" }], usage: { total_tokens: 42, tool_uses: 2 } }));
    const parent = f.latestActor("workflow");
    expect(f.actors().at(-1)).toMatchObject({ kind: "subagent", parentId: parent.id, nativeId: "checker", task: "Review" });
    expect(f.activities().at(-1)).toMatchObject({ actorId: parent.id, label: "Reported task usage", output: "42 total tokens · 2 tool uses" });
    expect(parent.usage?.output).toBeUndefined();
  });

  it("ends parent retries and thinking estimates only when parent work resumes", () => {
    const f = fixture();
    f.native.receive({ type: "system", subtype: "api_retry", uuid: "retry", attempt: 1 });
    f.native.receive({ type: "system", subtype: "thinking_tokens", estimated_tokens: 42, user_message_uuid: "turn" });
    f.native.receive(assistant("child", [{ type: "text", text: "Child progress" }], { agent_id: "child" }));
    expect(f.activities().filter(row => row.actorId === "parent").map(row => row.state)).toEqual(["waiting", "running"]);
    f.native.receive(assistant("parent", [{ type: "text", text: "Parent resumed" }]));
    const parent = [...new Map(f.activities().filter(row => row.actorId === "parent").map(row => [row.id, row])).values()];
    expect(parent.every(row => row.state === "done")).toBe(true);
    const firstThinking = parent.find(row => row.kind === "reasoning")!;
    expect(firstThinking.text).toBe("42 estimated thinking tokens");
    f.native.receive({ type: "system", subtype: "thinking_tokens", estimated_tokens: 64, user_message_uuid: "turn" });
    expect(f.activities().at(-1)?.id).not.toBe(firstThinking.id);
    f.native.receive({ type: "result", is_error: false });
    expect(f.activities().at(-1)?.state).toBe("done");
  });

  it("bounds search structures and excludes executable and credential-bearing URLs", () => {
    const links = claudeSearchLinks({ results: [{ url: "javascript:alert(1)", title: "Bad" }, { url: "https://user:password@example.com", title: "Private" }, ...Array.from({ length: 80 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}` }))] });
    expect(links).toHaveLength(30);
    expect(links.every(link => link.url.startsWith("https://example.com/"))).toBe(true);
    const f = fixture();
    f.native.receive(assistant("large", [{ type: "text", text: "x".repeat(30_000) }]));
    expect(f.activities()[0]).toMatchObject({ truncated: true, text: "x".repeat(24_000) });
  });
});
