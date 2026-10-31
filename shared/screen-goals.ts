import { TOOL_NAMESPACE, toolSurfaceKind } from "./tool-surface.ts";

export const SCREEN_GOALS_KEPT = 20;

export type ScreenAction = "look" | "click" | "type" | "key" | "scroll" | "open" | "drag" | "run" | "fill" | "other";

export interface ScreenGoalMessage {
  id: string;
  role: string;
  kind?: string;
  text?: string;
  at: number;
  tool?: { name: string; ok?: boolean; input?: unknown };
}

export interface ScreenStep {
  id: string;
  at: number;
  action: ScreenAction;
  detail?: string;
  ok: boolean;
}

export interface ScreenGoal {
  id: string;
  text: string;
  at: number;
  steps: ScreenStep[];
  latest: boolean;
}

const ACTIONS: ReadonlyArray<[RegExp, ScreenAction]> = [
  [/screenshot|screen_capture|zoom/, "look"],
  [/fill_secure_field/, "fill"],
  [/type|fill/, "type"],
  [/key|hotkey|press/, "key"],
  [/scroll/, "scroll"],
  [/open_url|navigate|launch_app|bring_to_front|agent_browser_open/, "open"],
  [/drag/, "drag"],
  [/click|select|check|hover|move/, "click"],
  [/^exec$|run_command|bash/, "run"],
];

function inputOf(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hostOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname.replace(/^www\./, "") : undefined;
  } catch {
    return undefined;
  }
}

function keysOf(input: Record<string, unknown>): string | undefined {
  const keys = input.keys ?? input.key ?? input.combo ?? input.text;
  const list = Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : typeof keys === "string" ? [keys] : [];
  const joined = list.join(" ").trim();
  return joined && joined.length <= 32 ? joined : undefined;
}

export function screenStep(message: ScreenGoalMessage): ScreenStep | null {
  const name = message.tool?.name;
  if (!name || message.kind !== "activity" || toolSurfaceKind(name) === null) return null;
  const bare = name.toLowerCase().replace(TOOL_NAMESPACE, "");
  const action = ACTIONS.find(([pattern]) => pattern.test(bare))?.[1] ?? "other";
  const input = inputOf(message.tool?.input);
  const typed = typeof input.text === "string" ? input.text : undefined;
  const detail = action === "open" ? hostOf(input.url) ?? (typeof input.app === "string" ? input.app : undefined)
    : action === "key" ? keysOf(input)
    : action === "type" && typed !== undefined ? String([...typed].length)
    : undefined;
  return { id: message.id, at: message.at, action, ok: message.tool?.ok !== false, ...(detail ? { detail } : {}) };
}

export function screenGoals(messages: readonly ScreenGoalMessage[], kept = SCREEN_GOALS_KEPT): ScreenGoal[] {
  const goals: ScreenGoal[] = [];
  let current: ScreenGoal | null = null;
  let lastAsk: ScreenGoalMessage | null = null;
  for (const message of [...messages].sort((a, b) => a.at - b.at)) {
    if (message.role === "user" && message.kind === "text" && message.text?.trim()) {
      lastAsk = message;
      current = null;
      continue;
    }
    if (message.role !== "bot") continue;
    const step = screenStep(message);
    if (!step || !lastAsk) continue;
    if (!current) {
      current = { id: lastAsk.id, text: lastAsk.text!.trim(), at: lastAsk.at, steps: [], latest: false };
      goals.push(current);
    }
    current.steps.push(step);
  }
  const latestAsk = lastAsk?.id;
  return goals.slice(-kept).map((goal) => ({ ...goal, latest: goal.id === latestAsk }));
}
