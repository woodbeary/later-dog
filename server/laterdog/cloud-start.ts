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
