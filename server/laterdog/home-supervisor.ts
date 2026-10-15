import { supervisorConnection } from "./config.ts";
import { availableDogMcpEnvironment } from "./dog-access.ts";

export const NO_SUPERVISOR_ENV = "LATERDOG_NO_SUPERVISOR";
export const NO_SUPERVISOR_FOR_DOGS = "Cloud jobs aren't available on My Cloud: no later.dog job supervisor runs here, so don't retry this tool. Do the work yourself instead: clone the repository into your working folder, make a branch, commit, push and open a draft pull request with git and gh.";
export const NO_SUPERVISOR_ON_MY_CLOUD = "Cloud jobs aren't available on My Cloud yet: no later.dog job supervisor runs here. Dogs on My Cloud work on repositories themselves once GitHub is connected in Settings.";

export function supervisorMissingOnHome(cloudHome: boolean, connection: () => { source: string } = supervisorConnection): boolean {
  if (!cloudHome) return false;
  try { return connection().source === "local"; } catch { return true; }
}

export function dogSupervisorEnvironment(botId: string, conversationId: string, missing: boolean): Record<string, string> | null {
  if (missing) return { [NO_SUPERVISOR_ENV]: "1", LATERDOG_BOT_ID: botId, LATERDOG_CONVERSATION_ID: conversationId };
  return availableDogMcpEnvironment(botId, conversationId);
}

export function supervisorMissingForDog(env: NodeJS.ProcessEnv = process.env): string | null {
  return env[NO_SUPERVISOR_ENV] === "1" ? NO_SUPERVISOR_FOR_DOGS : null;
}
