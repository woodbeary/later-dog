import type { ApprovalMode } from "../../shared/approval-mode.ts";

export interface CodexPermissionParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
}

export function containerIsTheSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LATERDOG_CLOUD_ROLE === "home";
}

export function withContainerAccess<T extends CodexPermissionParams>(
  params: T,
  mode: ApprovalMode,
  turn: { guestConfined?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (mode !== "auto" || turn.guestConfined || !containerIsTheSandbox(env)) return params;
  return {
    ...params,
    thread: { ...params.thread, sandbox: "danger-full-access" },
    turn: { ...params.turn, sandboxPolicy: { type: "dangerFullAccess" } },
  };
}
