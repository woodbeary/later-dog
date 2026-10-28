import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface PuppiesHost {
  out(event: unknown): void;
  init(): void;
  endTurn(): void;
  sessionId: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}

type Stage = "idle" | "running" | "done";

const AGENT_LABEL = "Survey the notes";
const FLOW_LABEL = "Draft and check";
const FLOW_NAME = "draft-and-check";
const AGENT_STEPS = ["Reading the notes", "Comparing two sections", "Listing open questions"];
const FLOW_STEPS = ["Drafting a summary", "Checking the summary"];
const USAGE = { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 };

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createPuppies(host: PuppiesHost): (promptText: string) => void {
  const env = host.env ?? process.env;
  const tickMs = positive(env.FAKE_CLAUDE_PUPPIES_TICK_MS, 1_000);
  const runMs = positive(env.FAKE_CLAUDE_PUPPIES_MS, 60_000);
  const staggerMs = positive(env.FAKE_CLAUDE_PUPPIES_STAGGER_MS, 500);
  const gate = env.FAKE_CLAUDE_PUPPIES_GATE;
  const flowGate = env.FAKE_CLAUDE_PUPPIES_FLOW_GATE;
  const reorder = env.FAKE_CLAUDE_PUPPIES_REORDER === "1";
  const echo = env.FAKE_CLAUDE_PUPPIES_ECHO === "1";
  const failFlow = env.FAKE_CLAUDE_PUPPIES_FAIL === "1";
  const foreground = env.FAKE_CLAUDE_PUPPIES_FOREGROUND === "1";
  const reportsItself = env.FAKE_CLAUDE_PUPPIES_REPORTS_ITSELF === "1";
  const { out } = host;
  let stage: Stage = "idle";
  let round = 0;
  let cost = 0;
  let startedAt = 0;
  let tick = 0;
  let agentDone = false;
  let flowDone = false;
  let ticker: NodeJS.Timeout | null = null;
  const system = (subtype: string, fields: Record<string, unknown>) =>
    out({ type: "system", subtype, ...fields, session_id: host.sessionId, uuid: `puppy-${subtype}-${round}-${tick}-${Math.random().toString(36).slice(2, 8)}` });
  const say = (text: string) => out({ type: "assistant", message: { content: [{ type: "text", text }], usage: USAGE } });
  const ids = () => ({
    agent: `puppy-agent-${round}`,
    agentTool: `tu-puppy-agent-${round}`,
    flow: `puppy-flow-${round}`,
    flowTool: `tu-puppy-flow-${round}`,
  });
  const result = () => {
    cost = Number((cost + 0.01).toFixed(2));
    out({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", num_turns: 1, total_cost_usd: cost, usage: USAGE });
    host.endTurn();
  };
  const notificationResult = () => {
    host.init();
    out({
      type: "result", subtype: "success", is_error: false, num_turns: 0, duration_ms: 0, duration_api_ms: 0, total_cost_usd: cost,
      origin: { kind: "task-notification", producer: "session-task", runId: `puppy-run-${round}` }, session_id: host.sessionId,
    });
  };
  const running = () => {
    const { agent, flow } = ids();
    return [
      ...(agentDone ? [] : [{ task_id: agent, run_id: `run-${agent}`, task_type: "local_agent", description: AGENT_LABEL }]),
      ...(flowDone ? [] : [{ task_id: flow, run_id: `run-${flow}`, task_type: "local_workflow", description: FLOW_LABEL }]),
    ];
  };
  const elapsed = () => Math.max(1, Date.now() - startedAt);
  const backMessage = () => failFlow
    ? "Both helpers are back. The survey found three things worth a closer look, but the draft did not pass its check."
    : "Both helpers are back. The survey found three things worth a closer look, and the draft passed its check.";
  const member = (index: number, label: string, phaseIndex: number, phaseTitle: string, state: string, steps: number) => ({
    type: "workflow_agent", index, label, phaseIndex, phaseTitle, agentId: `puppy-${label.toLowerCase()}-${round}`, model: host.model,
    state, lastToolName: phaseIndex === 0 ? "Write" : "Read", lastToolSummary: FLOW_STEPS[phaseIndex], tokens: 800 * steps,
    toolCalls: steps, durationMs: steps * tickMs, resultPreview: state === "done" ? `${label} finished` : undefined,
    error: state === "error" ? `${label} could not finish` : undefined, promptPreview: `${label}: ${FLOW_STEPS[phaseIndex]}`,
    queuedAt: startedAt, startedAt, lastProgressAt: Date.now(), attempt: 1,
  });
  const workflowProgress = (final: boolean) => {
    const drafterDone = final || tick >= 3;
    const checkerState = final ? (failFlow ? "error" : "done") : tick <= 3 ? "start" : "progress";
    return [
      { type: "workflow_phase", index: 0, title: "Draft" },
      { type: "workflow_phase", index: 1, title: "Check" },
      member(0, "Drafter", 0, "Draft", drafterDone ? "done" : tick === 0 ? "start" : "progress", Math.min(tick + 1, 3)),
      ...(drafterDone ? [member(1, "Checker", 1, "Check", checkerState, Math.max(1, tick - 2))] : []),
    ];
  };
  const progress = (final = false) => {
    const { agent, agentTool, flow, flowTool } = ids();
    if (!agentDone) {
      system("task_progress", {
        task_id: agent, tool_use_id: agentTool, description: AGENT_STEPS[tick % AGENT_STEPS.length], last_tool_name: "Read",
        usage: { total_tokens: 1_200 * (tick + 1), tool_uses: 2 * (tick + 1), duration_ms: elapsed() }, summary: "",
      });
    }
    if (!flowDone) {
      system("task_progress", {
        task_id: flow, tool_use_id: flowTool, description: FLOW_STEPS[tick >= 3 || final ? 1 : 0], last_tool_name: "Write",
        usage: { total_tokens: 900 * (tick + 1), tool_uses: tick + 1, duration_ms: elapsed() }, summary: "",
        workflow_progress: workflowProgress(final),
      });
    }
  };
  const finishTask = (which: "agent" | "flow") => {
    const { agent, agentTool, flow, flowTool } = ids();
    const taskId = which === "agent" ? agent : flow;
    const toolUseId = which === "agent" ? agentTool : flowTool;
    const status = which === "flow" && failFlow ? "failed" : "completed";
    const summary = which === "agent" ? "Found three things worth a closer look" : failFlow ? "The check did not pass" : "The draft passed its check";
    const usage = { total_tokens: 4_000, tool_uses: 7, duration_ms: elapsed() };
    if (which === "flow") progress(true);
    if (which === "agent") agentDone = true;
    else flowDone = true;
    const updated = () => system("task_updated", { task_id: taskId, patch: { status, end_time: Date.now() } });
    const notified = () => system("task_notification", {
      task_id: taskId, tool_use_id: toolUseId, status, summary, usage,
      output_file: join(tmpdir(), `fake-claude-${taskId}.output`),
    });
    const changed = () => system("background_tasks_changed", { tasks: running() });
    if (reorder) {
      changed();
      notified();
      updated();
    } else {
      updated();
      notified();
      changed();
    }
    if (reportsItself) say(agentDone && flowDone ? backMessage() : "The survey is back. Still waiting on the draft.");
    notificationResult();
    if (!agentDone || !flowDone) return;
    if (ticker) clearInterval(ticker);
    ticker = null;
    stage = "done";
    if (!echo) return;
    for (const again of ["agent", "flow"] as const) {
      const id = again === "agent" ? agent : flow;
      system("task_notification", {
        task_id: id, tool_use_id: again === "agent" ? agentTool : flowTool, status: again === "flow" && failFlow ? "failed" : "completed",
        summary: "repeated", usage, output_file: join(tmpdir(), `fake-claude-${id}.output`),
      });
    }
    notificationResult();
  };
  const waitFor = (path: string | undefined, delayMs: number, then: () => void) => {
    if (!path) {
      setTimeout(then, delayMs);
      return;
    }
    const poll = setInterval(() => {
      if (!existsSync(path)) return;
      clearInterval(poll);
      then();
    }, 10);
  };
  const runForeground = () => {
    const task = `puppy-fg-${round}`;
    const tool = `tu-puppy-fg-${round}`;
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: tool, name: "Agent", input: { description: "Check the outline", subagent_type: "Explore", prompt: "Check the outline." } }], usage: USAGE } });
    system("task_started", { task_id: task, tool_use_id: tool, description: "Check the outline", task_type: "local_agent", subagent_type: "Explore", is_backgrounded: false, prompt: "Check the outline." });
    system("task_progress", { task_id: task, tool_use_id: tool, description: "Reading the outline", last_tool_name: "Read", usage: { total_tokens: 600, tool_uses: 1, duration_ms: 40 }, summary: "" });
    system("task_notification", { task_id: task, tool_use_id: tool, status: "completed", summary: "The outline looks complete", usage: { total_tokens: 900, tool_uses: 2, duration_ms: 80 }, output_file: join(tmpdir(), `fake-claude-${task}.output`) });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: tool, is_error: false, content: [{ type: "text", text: "The outline looks complete." }] }] } });
  };
  const launch = () => {
    round += 1;
    tick = 0;
    agentDone = false;
    flowDone = false;
    startedAt = Date.now();
    stage = "running";
    const { agent, agentTool, flow, flowTool } = ids();
    say("Two helpers will look into this in the background.");
    if (foreground) runForeground();
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: agentTool, name: "Agent", input: { description: AGENT_LABEL, subagent_type: "general-purpose", prompt: "Survey the notes and list what stands out.", run_in_background: true } }], usage: USAGE } });
    system("task_started", { task_id: agent, tool_use_id: agentTool, description: AGENT_LABEL, task_type: "local_agent", subagent_type: "general-purpose", is_backgrounded: true, prompt: "Survey the notes and list what stands out." });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: agentTool, is_error: false, content: [{ type: "text", text: "Async agent launched successfully. You will be notified when it completes." }] }] } });
    out({ type: "assistant", message: { content: [{ type: "tool_use", id: flowTool, name: "Workflow", input: { name: FLOW_NAME, description: FLOW_LABEL } }], usage: USAGE } });
    system("task_started", { task_id: flow, tool_use_id: flowTool, description: FLOW_LABEL, task_type: "local_workflow", workflow_name: FLOW_NAME });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: flowTool, is_error: false, content: [{ type: "text", text: "Workflow started in the background. You will be notified when it completes." }] }] } });
    system("background_tasks_changed", { tasks: running() });
    progress();
    say("They're working now. I'll come back with what they find.");
    result();
    ticker = setInterval(() => {
      tick += 1;
      progress();
    }, tickMs);
    waitFor(gate, runMs, () => {
      finishTask("agent");
      waitFor(flowGate, staggerMs, () => finishTask("flow"));
    });
  };
  return (promptText) => {
    if (stage === "idle") {
      launch();
      return;
    }
    if (stage === "running") {
      say(`Still waiting on the helpers. Noted: ${promptText || "your message"}`);
      result();
      return;
    }
    stage = "idle";
    say(backMessage());
    result();
  };
}
