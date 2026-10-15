import type { CloudMove, CloudMoveState, MoveContents, MoveEstimate, MoveTarget } from "./cloud-move.mjs";

export type AutoMoveStatus = "moved" | "joined";
export interface StayedOnMac { name: string; bytes: number }
export interface AutoMoveRecord { status: AutoMoveStatus; at: number; origin: string; contents?: MoveContents; stayedOnMac?: StayedOnMac[] }
export type AutoMoveOutcome = { status: AutoMoveStatus | "nothing" | "busy" } | { status: "failed"; code?: string; retryInMs?: number };
export declare function worthMoving(local: Pick<MoveEstimate, "bots" | "rooms" | "chats"> | null | undefined): boolean;
export declare function parseMoveRecords(raw: unknown): Record<string, AutoMoveRecord>;
export declare function serializeMoveRecords(records: Record<string, AutoMoveRecord>): string;
export interface CloudAutoMove {
  status(accountId: string, destination?: MoveTarget): AutoMoveStatus | null;
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
  log?: (message: string) => void;
  pause?: (held: boolean) => Promise<unknown>;
  onMoved?: (destination: MoveTarget, result: CloudMoveState) => void;
  onJoined?: (destination: MoveTarget) => void;
  onFailed?: (reason: { code: string; message: string }) => void;
}): CloudAutoMove;
