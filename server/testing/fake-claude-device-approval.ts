import { callDogTool } from "./fake-claude-asks.ts";

type Emit = (event: Record<string, unknown>) => void;
type McpServer = { command?: string; args?: string[]; env?: Record<string, string> };

export interface FakeDeviceApprovalPlan {
  holdMs: number;
  expiresInMs: number;
  service: string;
}

export function fakeDeviceApprovalPlan(env: NodeJS.ProcessEnv): FakeDeviceApprovalPlan {
  const number = (raw: string | undefined, fallback: number) => {
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    holdMs: number(env.FAKE_CLAUDE_DEVICE_HOLD_MS, 0),
    expiresInMs: number(env.FAKE_CLAUDE_DEVICE_EXPIRES_MS, 8_000),
    service: env.FAKE_CLAUDE_DEVICE_SERVICE?.trim() || "Fixture CLI",
  };
}

export async function playDeviceApprovalTurn(options: {
  agents: McpServer | undefined;
  plan: FakeDeviceApprovalPlan;
  out: Emit;
  nextId: () => string;
  now?: () => number;
}): Promise<void> {
  const { agents, plan, out, nextId } = options;
  const now = options.now ?? Date.now;
  const say = (text: string) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  if (!agents?.command) {
    say("no agents server");
    return;
  }
  say(`I'm opening a ${plan.service} sign-in card.`);
  if (plan.holdMs) await new Promise((resolve) => setTimeout(resolve, plan.holdMs));
  const args = {
    service: plan.service,
    url: "https://device.example.test/verify",
    code: `C${String(now() % 1_000_000).padStart(6, "0")}`,
    expiresAt: String(now() + plan.expiresInMs),
  };
  const id = nextId();
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "mcp__agents__request_device_approval", input: args }] } });
  const text = await callDogTool(agents, "request_device_approval", args);
  const refused = !/now sees a card/.test(text);
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: refused, content: [{ type: "text", text }] }] } });
  say(refused ? `The sign-in card was not shown: ${text}` : "Tap Open, enter the code, and I'll carry on once it's approved.");
}
