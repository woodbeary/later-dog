import { existsSync } from "node:fs";

interface NativeActivityHost {
  out(event: unknown): void;
  endTurn(): void;
  sessionId: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}

export function createNativeActivity(host: NativeActivityHost): () => Promise<void> {
  let round = 0;
  let sequence = 0;
  const gate = (host.env ?? process.env).FAKE_CLAUDE_NATIVE_GATE;
  const emit = (event: Record<string, unknown>) => host.out({ ...event, session_id: host.sessionId, uuid: `native-fixture-${round}-${++sequence}` });
  const names = ["Researcher", "Builder", "Checker", "Writer", "Analyst", "Reviewer", "Nested inspector"];
  const task = (index: number) => `native-task-${round}-${index}`;
  const invocation = (index: number) => `native-agent-tool-${round}-${index}`;
  const runId = () => `00000000-${String(round).padStart(4, "0")}`;
  const assistant = (content: unknown[], index?: number) => emit({ type: "assistant", parent_tool_use_id: index === undefined ? null : invocation(index), ...(index === undefined ? {} : { agent_id: task(index) }), message: { id: `native-message-${round}-${sequence + 1}`, role: "assistant", model: host.model, content, usage: { input_tokens: index === undefined ? 42 : 999_999, output_tokens: index === undefined ? 8 : 999_999 } } });
  const toolResult = (toolId: string, content: unknown, index?: number, failed = false) => emit({ type: "user", parent_tool_use_id: index === undefined ? null : invocation(index), ...(index === undefined ? {} : { agent_id: task(index) }), message: { content: [{ type: "tool_result", tool_use_id: toolId, content, is_error: failed }] } });
  const finishTask = (index: number, failed = false) => {
    const summary = failed ? "Checker found a deliberate fixture failure." : `${names[index]} completed the assigned check.`;
    emit({ type: "system", subtype: "task_notification", task_id: task(index), run_id: runId(), tool_use_id: invocation(index), status: failed ? "failed" : "completed", summary, usage: { total_tokens: 120, tool_uses: 2, duration_ms: 100 } });
    toolResult(invocation(index), summary, index === 6 ? 0 : undefined, failed);
  };
  return async () => {
    round += 1;
    if (!gate) {
      emit({ type: "result", is_error: true, result: "FAKE_CLAUDE_NATIVE_GATE is required by the native activity fixture.", stop_reason: "error" });
      host.endTurn();
      return;
    }
    assistant([{ type: "text", text: "Parent: I am checking the native helper activity." }]);
    for (let index = 0; index < names.length; index += 1) {
      const description = names[index]!;
      const parent = index === 6 ? 0 : undefined;
      assistant([{ type: "tool_use", id: invocation(index), name: "Agent", input: { description, subagent_type: "general-purpose", prompt: `${description}: inspect the synthetic fixture.` } }], parent);
      emit({ type: "system", subtype: "task_started", task_id: task(index), run_id: runId(), tool_use_id: invocation(index), task_type: "local_agent", description, prompt: `${description}: inspect the synthetic fixture.`, spawn_depth: index === 6 ? 2 : 1, is_backgrounded: false, ...(index === 6 ? { parent_task_id: task(0) } : {}) });
      assistant([{ type: "thinking", thinking: `${description} is comparing the fixture evidence.` }, { type: "text", text: `CHILD_ONLY_${index}: ${description} internal progress.` }], index);
    }
    assistant([{ type: "text", text: "Parent: The helpers are running while I review their reports." }]);
    const searchId = `native-search-${round}`;
    assistant([{ type: "tool_use", id: searchId, name: "WebSearch", input: { query: "Claude Code native subagent documentation" } }], 0);
    toolResult(searchId, [{ type: "text", text: JSON.stringify({ results: [{ title: "Claude Code subagents", url: "https://code.claude.com/docs/en/sub-agents" }] }) }], 0);
    const readId = `native-read-${round}`;
    assistant([{ type: "tool_use", id: readId, name: "Read", input: { file_path: "/fixture/notes.txt" } }], 6);
    toolResult(readId, "Nested fixture notes were read successfully.", 6);
    const failureId = `native-failure-${round}`;
    assistant([{ type: "tool_use", id: failureId, name: "Bash", input: { command: "fixture-check" } }], 2);
    toolResult(failureId, "Deliberate fixture failure: missing synthetic expectation.", 2, true);
    finishTask(2, true);
    const activeSearchId = `native-search-active-${round}`;
    assistant([{ type: "tool_use", id: activeSearchId, name: "WebSearch", input: { query: "Native helper result verification" } }], 0);
    while (!existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
    toolResult(activeSearchId, "All synthetic native helper checks are recorded.", 0);
    for (const index of [6, 0, 1, 3, 4, 5]) finishTask(index);
    assistant([{ type: "text", text: "Parent: Native activity fixture complete. One helper reported the expected failure." }]);
    emit({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 42, output_tokens: 8 } });
    host.endTurn();
  };
}
