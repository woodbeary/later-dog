export type DirectApply = "full-access" | "self" | "owner-auto";

export type DirectApplyCheck = (botId: string, threadId: string, targetBotId: string) => DirectApply | null;

export const UNDO_STALE = "Changed since, so it can't be undone here.";

export function directApply(args: {
  fullAccess: boolean;
  botId: string;
  targetBotId: string;
  blocked: boolean;
}): DirectApply | null {
  if (args.fullAccess) return "full-access";
  return args.targetBotId === args.botId && !args.blocked ? "self" : null;
}

export function routineApply(args: {
  direct: DirectApply | null;
  owner: boolean;
  blocked: boolean;
}): DirectApply | null {
  return args.direct ?? (args.owner && !args.blocked ? "owner-auto" : null);
}
