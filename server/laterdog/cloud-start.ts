import { cloudRefusal } from "../../shared/place-view.ts";

export interface StartRetry {
  deadline: number;
  pauseMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  passing: (error: unknown) => boolean;
}

export function passingCloudFailure(error: unknown, included: boolean): boolean {
  if (!(error instanceof Error)) return false;
  const { boatCode, boatStatus, status } = error as { boatCode?: unknown; boatStatus?: unknown; status?: unknown };
  const providerStatus = typeof boatStatus === "number" ? boatStatus : typeof status === "number" ? status : undefined;
  return cloudRefusal({
    message: error.message,
    ...(typeof boatCode === "string" ? { code: boatCode } : {}),
    ...(providerStatus !== undefined ? { status: providerStatus } : {}),
  }, included).state === "cc-unavailable";
}

export async function startRetryingPassingFailures<T>(start: () => Promise<T>, retry: StartRetry): Promise<T> {
  for (;;) {
    try {
      return await start();
    } catch (error) {
      if (!retry.passing(error) || retry.now() + retry.pauseMs >= retry.deadline) throw error;
      await retry.sleep(retry.pauseMs);
    }
  }
}

export const CLOUD_COMPUTER_BOOT_MS = 5 * 60_000;
export const CLOUD_COMPUTER_START_MARGIN_MS = 30_000;

export function cloudComputerStartBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.LATERDOG_CLOUD_COMPUTER_START_BUDGET_MS);
  return override > 0 ? Math.max(1_000, override) : CLOUD_COMPUTER_BOOT_MS + CLOUD_COMPUTER_START_MARGIN_MS;
}

export function remainingStartMs(deadline: number, now: number): number {
  return Math.max(1, deadline - now);
}
