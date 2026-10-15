import type { CloudAutoMove } from "./cloud-auto-move.mjs";
import type { MacHold } from "./cloud-hold.mjs";
import type { MoveTarget } from "./cloud-move.mjs";

export type WindowChoice =
  | { kind: "keep"; signedOut?: false }
  | { kind: "local"; signedOut?: boolean; screen?: "waking" | "moving" | null; accountId?: string }
  | { kind: "cloud"; origin: string; accountId: string; move?: string };
export declare function windowChoice(input: { state: unknown; autoMove: "pending" | "moving" | "failed" }): WindowChoice;
export declare function createCloudWindow(options: {
  autoMove: Pick<CloudAutoMove, "ensure" | "retry" | "stop">;
  hold: Pick<MacHold, "set">;
  showHome(destination: MoveTarget): unknown;
  showLocal(): unknown;
  destinationFor(choice: { origin: string; accountId: string }): MoveTarget;
  log?: (message: string) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: never) => void;
  retryWith?: ((state: unknown) => Promise<WindowChoice | null>) | null;
}): { sync(state: unknown, manual?: boolean): Promise<WindowChoice>; retry(state: unknown): Promise<WindowChoice>; cancelRetry(): void; close(): void; moving(): boolean };
