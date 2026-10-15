import type { CloudAutoMove } from "./cloud-auto-move.mjs";
import type { MacHold } from "./cloud-hold.mjs";
import type { MoveTarget } from "./cloud-move.mjs";

export type WindowChoice =
  | { kind: "keep"; signedOut?: false }
  | { kind: "local"; signedOut?: boolean; screen?: "waking" | "moving" | null; accountId?: string }
  | { kind: "cloud"; origin: string; accountId: string; move?: string };
export declare function windowChoice(input: { state: unknown; autoMove: "pending" | "moving" | "failed" }): WindowChoice;
export declare function createCloudWindow(options: {
  autoMove: Pick<CloudAutoMove, "ensure" | "stop">;
  hold: Pick<MacHold, "set">;
  showHome(destination: MoveTarget): unknown;
  showLocal(): unknown;
  destinationFor(choice: { origin: string; accountId: string }): MoveTarget;
  log?: (message: string) => void;
}): { sync(state: unknown): Promise<WindowChoice>; retry(state: unknown): Promise<WindowChoice>; moving(): boolean };
