import type { ModelSelection } from "./wire.ts";

export interface ModelRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  targetBotId: string;
  targetName: string;
  createdAt: number;
  reason: string;
  selection: ModelSelection;
  before: ModelSelection;
  appliedAt?: number;
}
