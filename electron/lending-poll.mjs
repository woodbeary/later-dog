export const DROPPED_POLL_RETRY_MS = Object.freeze([250, 1000, 3000]);

export function droppedPollRetryMs(error, dropped, signal) {
  if (signal?.aborted || dropped >= DROPPED_POLL_RETRY_MS.length) return null;
  if (error?.home || error?.problem) return null;
  if (typeof error?.status === "number" && error.status < 500) return null;
  return DROPPED_POLL_RETRY_MS[dropped];
}
