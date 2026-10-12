
export type DirectApply = "full-access" | "self";

export type DirectApplyCheck = (botId: string, threadId: string, targetBotId: string) => DirectApply | null;

export const UNDO_STALE = "Changed since, so it can't be undone here.";

export const SELF_ROUTINE_CAP = 20;

export function directApply(args: {
  fullAccess: boolean;
  botId: string;
  targetBotId: string;
  blocked: boolean;
}): DirectApply | null {
  if (args.fullAccess) return "full-access";
  return args.targetBotId === args.botId && !args.blocked ? "self" : null;
}
