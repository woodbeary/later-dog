import type { EffortLevel } from "./wire.ts";

export interface TurnReceiptSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
}

export interface TurnReceipt {
  account?: string;
  instanceId: string;
  model: string;
  reportedModel?: string;
  effort?: EffortLevel;
  selected?: TurnReceiptSelection;
}
