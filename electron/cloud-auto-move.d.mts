import type { CloudMove, MoveContents, MoveEstimate, MoveTarget } from "./cloud-move.mjs";

export declare const AUTO_MOVE_RETRY_MS: readonly number[];
export type AutoMoveStatus = "moved" | "nothing" | "kept-local";
export interface AutoMoveRecord { status: AutoMoveStatus; at: number; origin?: string; contents?: MoveContents }
export type AutoMoveOutcome = { status: AutoMoveStatus | "busy" | "waiting" } | { status: "failed"; code?: string };
export declare function worthMoving(local: Pick<MoveEstimate, "bots" | "rooms" | "chats"> | null | undefined): boolean;
export declare function parseMoveRecords(raw: unknown): Record<string, AutoMoveRecord>;
export declare function serializeMoveRecords(records: Record<string, AutoMoveRecord>): string;
export interface CloudAutoMove {
  status(accountId: string): AutoMoveStatus | null;
  ensure(accountId: string | null | undefined, destination: MoveTarget): Promise<AutoMoveOutcome>;
  retry(accountId: string, destination: MoveTarget): Promise<AutoMoveOutcome>;
  stop(): void;
  close(): void;
}
export declare function createCloudAutoMove(options: {
  move: Pick<CloudMove, "estimate" | "move" | "running">;
  read(): unknown;
  write(contents: string): void;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  retryDelaysMs?: readonly number[];
  log?: (message: string) => void;
  onMoved?: (destination: MoveTarget) => void;
}): CloudAutoMove;
