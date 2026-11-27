export interface PickupStops {
  stop(threadId: string): void;
  stopped(threadId: string): boolean;
  resuming(threadId: string): void;
  settled(threadId: string): void;
  resumed(threadId: string): boolean;
}

export function createPickupStops(): PickupStops {
  const stopped = new Set<string>();
  const resumed = new Set<string>();
  return {
    stop: (threadId) => { stopped.add(threadId); },
    stopped: (threadId) => stopped.has(threadId),
    resuming: (threadId) => { resumed.add(threadId); },
    settled: (threadId) => { resumed.delete(threadId); },
    resumed: (threadId) => resumed.has(threadId),
  };
}

export interface SeenTurn {
  seen?: unknown;
  running?: number;
  resumed: boolean;
}

export function keepsNewerTurn({ seen, running, resumed }: SeenTurn): boolean {
  if (typeof seen !== "number" || !Number.isFinite(seen) || running === undefined || resumed) return false;
  return running > seen;
}

export interface PersonMessage { id: string; role: string; kind: string; requestCancelled?: boolean }

export function persistPickupStop(path: readonly PersonMessage[], cancel: (messageId: string) => void): void {
  const source = path.findLast((message) => message.role === "user");
  if (source && !source.requestCancelled) cancel(source.id);
}
