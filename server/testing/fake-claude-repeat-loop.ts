type Emit = (event: Record<string, unknown>) => void;

export interface FakeRepeatLoopPlan {
  times: number;
  gapMs: number;
  command: string;
  changing: boolean;
}

export function fakeRepeatLoopPlan(env: NodeJS.ProcessEnv): FakeRepeatLoopPlan {
  const count = Number(env.FAKE_CLAUDE_REPEAT_TIMES);
  const gap = Number(env.FAKE_CLAUDE_REPEAT_GAP_MS);
  return {
    times: Number.isInteger(count) && count > 0 ? count : 30,
    gapMs: Number.isFinite(gap) && gap >= 0 ? gap : 40,
    command: env.FAKE_CLAUDE_REPEAT_COMMAND?.trim() || "fixture-cli auth status",
    changing: env.FAKE_CLAUDE_REPEAT_ANSWER === "changing",
  };
}

export function fakeRepeatAnswer(plan: FakeRepeatLoopPlan, round: number): string {
  return plan.changing ? `build running, step ${round + 1} of ${plan.times}` : "Not signed in. Open the sign-in page to continue.";
}

export async function playRepeatLoopTurn(options: { plan: FakeRepeatLoopPlan; out: Emit; nextId: () => string }): Promise<void> {
  const { plan, out, nextId } = options;
  out({ type: "assistant", message: { content: [{ type: "text", text: `Checking ${plan.command}.` }] } });
  for (let round = 0; round < plan.times; round++) {
    const id = nextId();
    out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: plan.command } }] } });
    if (plan.gapMs) await new Promise((resolve) => setTimeout(resolve, plan.gapMs));
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: [{ type: "text", text: fakeRepeatAnswer(plan, round) }] }] } });
  }
  out({ type: "assistant", message: { content: [{ type: "text", text: `Finished checking ${plan.command} ${plan.times} times.` }] } });
}
