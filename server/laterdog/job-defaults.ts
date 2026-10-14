import { JOB_EFFORTS, jobAccount, jobModel, type JobEffort } from "../../shared/laterdog.ts";

export interface DogChoices { instanceId: string; model: string; effort?: string }
export interface JobChoices { account?: string; model?: string; effort?: JobEffort }

export const DOG_CHOICE_ENV = { account: "LATERDOG_ACCOUNT", model: "LATERDOG_MODEL", effort: "LATERDOG_EFFORT" } as const;

export function dogJobEnvironment(selection: DogChoices | undefined, driverKind: string | undefined): Record<string, string> {
  if (!selection || driverKind !== "claudeAgent") return {};
  return {
    ...(jobAccount.safeParse(selection.instanceId).success ? { [DOG_CHOICE_ENV.account]: selection.instanceId } : {}),
    ...(jobModel.safeParse(selection.model).success ? { [DOG_CHOICE_ENV.model]: selection.model } : {}),
    ...((JOB_EFFORTS as readonly string[]).includes(selection.effort ?? "") ? { [DOG_CHOICE_ENV.effort]: selection.effort as string } : {}),
  };
}

export function dogJobDefaults(env: NodeJS.ProcessEnv): JobChoices {
  const account = env[DOG_CHOICE_ENV.account]?.trim();
  const model = env[DOG_CHOICE_ENV.model]?.trim();
  const effort = env[DOG_CHOICE_ENV.effort]?.trim();
  return {
    ...(account && jobAccount.safeParse(account).success ? { account } : {}),
    ...(model && jobModel.safeParse(model).success ? { model } : {}),
    ...(effort && (JOB_EFFORTS as readonly string[]).includes(effort) ? { effort: effort as JobEffort } : {}),
  };
}
