const READY_BOAT_STATES = new Set(["idle", "ready", "running"]);

export function isReadyBoatState(state: string | null | undefined): boolean {
  return typeof state === "string" && READY_BOAT_STATES.has(state);
}
