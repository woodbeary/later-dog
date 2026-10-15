import type { SteerOutcome } from "../contracts.ts";
import type { Message } from "../store.ts";

export interface QueuedSteerTiming {
  stopMs: number;
  settleMs: number;
  pollMs: number;
}

export const QUEUED_STEER_TIMING: QueuedSteerTiming = {
  stopMs: 10_000,
  settleMs: Math.max(0, Number(process.env.LATERDOG_QUEUED_STEER_SETTLE_MS) || 8_000),
  pollMs: 50,
};

export const STEER_RETRY = { attempts: 6, delayMs: 250 };

export async function steerWhileRunning(
  steer: () => Promise<SteerOutcome>,
  stillRunning: () => boolean,
  retry: { attempts: number; delayMs: number } = STEER_RETRY,
): Promise<SteerOutcome> {
  const attempt = () => Promise.resolve().then(steer).catch((): SteerOutcome => "indeterminate");
  let outcome = await attempt();
  for (let tries = 1; outcome === "refused" && tries < retry.attempts; tries++) {
    await new Promise((resolve) => setTimeout(resolve, retry.delayMs));
    if (!stillRunning()) break;
    outcome = await attempt();
  }
  return outcome;
}

export type SentAsNextTurn = {
  ok: true;
  sent: true;
  interrupted: boolean;
  threadId: string;
  queueIds: string[];
  messages: Message[];
};

export type StillQueued = { ok: true; queued: true; threadId: string; reason: string };

export interface NextTurnSend {
  threadId: string;
  name: string;
  queueIds: readonly string[];
  busy: () => boolean;
  waiting: (queueId: string) => boolean;
  interrupt: () => Promise<unknown>;
  drain: () => void;
  messages: () => readonly Message[];
}

export function stillStoppingReason(name: string): string {
  return `${name} hasn't stopped yet. Your message will be sent as soon as it does.`;
}

export function stillBlockedReason(name: string): string {
  return `${name} can't take your message yet. It will be sent as soon as ${name} is free.`;
}

export async function sendQueuedAsNextTurn(
  send: NextTurnSend,
  timing: QueuedSteerTiming = QUEUED_STEER_TIMING,
): Promise<SentAsNextTurn | StillQueued> {
  const [head] = send.queueIds;
  const started = () => head === undefined || !send.waiting(head);
  const nudge = () => {
    if (!started() && !send.busy()) send.drain();
    return started();
  };
  const interrupted = send.busy();
  if (interrupted) await settledWithin(Promise.resolve().then(send.interrupt), timing.stopMs);
  if (await pollUntil(nudge, interrupted ? timing.settleMs : 0, timing.pollMs)) {
    const left = send.queueIds.filter((queueId) => !send.waiting(queueId));
    const ids = new Set(left);
    return {
      ok: true,
      sent: true,
      interrupted,
      threadId: send.threadId,
      queueIds: left,
      messages: send.messages().filter((message) =>
        message.role === "user" && message.queueId !== undefined && ids.has(message.queueId)),
    };
  }
  return {
    ok: true,
    queued: true,
    threadId: send.threadId,
    reason: send.busy() ? stillStoppingReason(send.name) : stillBlockedReason(send.name),
  };
}

async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
  if (timer) clearTimeout(timer);
}

async function pollUntil(done: () => boolean, ms: number, everyMs: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
