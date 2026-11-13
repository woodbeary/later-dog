import { HARNESS_COMPACTING_DRIVERS } from "./native-compaction.ts";

export interface TurnSession {
  resumeCursor?: unknown;
}

export function recallsThisTurn(turn: TurnSession, driverKind: string): boolean {
  return turn.resumeCursor === undefined || !HARNESS_COMPACTING_DRIVERS.has(driverKind);
}
