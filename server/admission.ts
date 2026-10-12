
export type AdmissionSurface =
  | "direct-busy"
  | "direct"
  | "room"
  | "room-steer"
  | "guarded"
  | "unattended"
  | "peer"
  | "opened-thread";

export type AdmissionQueueReason = "capacity" | "group-turn";

export type AdmissionRefusalCode = "guarded_busy" | "queue-head-only" | "busy" | "missing";


export const DRAIN_COALESCE_WINDOW_MS = 120_000;

export const DRAIN_COALESCE_MAX_ITEMS = 30;

export function drainCoalesceHead<T>(
  items: readonly T[],
  identityOf: (item: T) => string,
  queuedAtOf: (item: T) => number,
  maxItems?: number,
): T[] {
  const head: T[] = [];
  let previousIdentity: string | undefined;
  let previousAt: number | undefined;
  for (const item of items) {
    if (maxItems !== undefined && head.length >= maxItems) break;
    const identity = identityOf(item);
    const at = queuedAtOf(item);
    const gap = at - (previousAt ?? at);
    if (head.length === 0 || (identity === previousIdentity && gap >= 0 && gap <= DRAIN_COALESCE_WINDOW_MS)) {
      head.push(item);
    } else {
      break;
    }
    previousIdentity = identity;
    previousAt = at;
  }
  return head;
}

export interface AdmissionMessage {
  carriesImages?: boolean;
  pendingComputerSelection?: boolean;
  engineCanSteer?: boolean;
  engineSteersImages?: boolean;
  waitsForTurn?: boolean;
  isQueueHead?: boolean;
  speakerPresent?: boolean;
}

export interface AdmissionState {
  botPresent?: boolean;
  botBusy?: boolean;
  threadBusy?: boolean;
  atCapacity?: boolean;
  groupTurn?: boolean;
  parksBehindCoordination?: boolean;
  roomWorking?: boolean;
}

export type AdmissionDecision =
  | { action: "steer" }
  | { action: "queue"; reason?: AdmissionQueueReason }
  | { action: "start" }
  | { action: "refuse"; code: AdmissionRefusalCode };

export function admit(
  surface: AdmissionSurface,
  message: AdmissionMessage = {},
  state: AdmissionState = {},
): AdmissionDecision {
  switch (surface) {
    case "direct-busy": {
      const steerable = !message.waitsForTurn && (!message.carriesImages || message.engineSteersImages === true) && !message.pendingComputerSelection && message.engineCanSteer === true;
      return steerable ? { action: "steer" } : { action: "queue" };
    }
    case "direct": {
      if (state.atCapacity || state.threadBusy || state.groupTurn || state.parksBehindCoordination) {
        const reason = state.atCapacity ? "capacity" : state.groupTurn ? "group-turn" : undefined;
        return { action: "queue", reason };
      }
      return { action: "start" };
    }
    case "room":
      return state.roomWorking ? { action: "queue" } : { action: "start" };
    case "room-steer": {
      if (!message.speakerPresent || message.engineCanSteer !== true) {
        return { action: "queue" };
      }
      if (!message.isQueueHead) {
        return { action: "refuse", code: "queue-head-only" };
      }
      return { action: "steer" };
    }
    case "guarded": {
      if (state.botBusy || state.threadBusy || state.atCapacity || state.parksBehindCoordination || state.groupTurn) {
        return { action: "refuse", code: "guarded_busy" };
      }
      return { action: "start" };
    }
    case "unattended": {
      if (state.botPresent === false) return { action: "refuse", code: "missing" };
      if (state.atCapacity || state.groupTurn) return { action: "refuse", code: "busy" };
      return { action: "start" };
    }
    case "peer": {
      if (state.threadBusy || state.atCapacity || state.groupTurn) return { action: "refuse", code: "busy" };
      return { action: "start" };
    }
    case "opened-thread": {
      if (state.atCapacity || state.groupTurn) {
        return { action: "queue", reason: state.atCapacity ? "capacity" : "group-turn" };
      }
      return { action: "start" };
    }
  }
}
