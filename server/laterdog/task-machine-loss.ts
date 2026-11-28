export const LOSS_RETRIES = 3;
export const LOSS_WINDOW_MS = 60 * 60_000;
export const LOSS_POLL_MS = 2_000;
export const LOSS_WAIT_MS = 5 * 60_000;
export const LOSS_NOTE = "Your task machine stopped in the middle of this turn, so this runs on a fresh one with the same files as of the last save. Check what is already done, then carry on.";

export interface LossHost {
  busy(botId: string, threadId: string): boolean;
  request(threadId: string): string | undefined;
  start(botId: string, threadId: string, prompt: string, requestMessageId: string): Promise<unknown>;
  note(threadId: string, text: string): void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export function taskMachineLoss(host: LossHost) {
  const now = host.now ?? Date.now;
  const wait = host.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const tries = new Map<string, number[]>();
  return async function pickUp(botId: string, threadId: string, machineId: string): Promise<"started" | "gave_up" | "busy" | "no_request"> {
    const at = now();
    const recent = (tries.get(threadId) ?? []).filter((time) => at - time < LOSS_WINDOW_MS);
    if (recent.length >= LOSS_RETRIES) {
      host.note(threadId, `Task machine ${machineId} stopped mid-turn ${recent.length + 1} times within an hour, so this task is left as it is. Send a message to carry on.`);
      return "gave_up";
    }
    const deadline = at + LOSS_WAIT_MS;
    while (host.busy(botId, threadId)) {
      if (now() >= deadline) return "busy";
      await wait(LOSS_POLL_MS);
    }
    const request = host.request(threadId);
    if (!request) return "no_request";
    tries.set(threadId, [...recent, now()]);
    host.note(threadId, `Task machine ${machineId} stopped mid-turn; carrying on on a fresh machine (try ${recent.length + 1} of ${LOSS_RETRIES}).`);
    await host.start(botId, threadId, LOSS_NOTE, request);
    return "started";
  };
}
